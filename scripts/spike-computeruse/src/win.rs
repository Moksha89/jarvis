//! Windows-only probing: window discovery, UI Automation inspection and GDI capture.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use windows::core::BSTR;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits,
    GetWindowDC, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    SRCCOPY,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationValuePattern,
    TreeScope_Subtree, UIA_ButtonControlTypeId, UIA_EditControlTypeId, UIA_InvokePatternId,
    UIA_ListItemControlTypeId, UIA_MenuItemControlTypeId, UIA_TabItemControlTypeId,
    UIA_ValuePatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowTextW, IsWindowVisible,
};

use crate::findings::Finding;
use crate::targets::Target;

struct Candidate {
    hwnd: HWND,
    class: String,
    title: String,
}

/// COM must be initialised once per thread before any UIA call.
pub fn init_com() -> Result<(), String> {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|error| format!("CoInitializeEx failed: {error}"))
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<Candidate>);
    if !IsWindowVisible(hwnd).as_bool() {
        return TRUE;
    }
    let mut class_buffer = [0u16; 256];
    let class_len = GetClassNameW(hwnd, &mut class_buffer);
    let mut title_buffer = [0u16; 512];
    let title_len = GetWindowTextW(hwnd, &mut title_buffer);
    list.push(Candidate {
        hwnd,
        class: String::from_utf16_lossy(&class_buffer[..class_len.max(0) as usize]),
        title: String::from_utf16_lossy(&title_buffer[..title_len.max(0) as usize]),
    });
    TRUE
}

/// Polls visible top-level windows until one matches the target, or the deadline passes.
pub fn wait_for_window(target: &Target, timeout: Duration) -> Option<(HWND, String, String, u128)> {
    let started = Instant::now();
    loop {
        let mut candidates: Vec<Candidate> = Vec::new();
        let pointer = &mut candidates as *mut Vec<Candidate>;
        unsafe {
            let _ = EnumWindows(Some(enum_proc), LPARAM(pointer as isize));
        }
        for candidate in &candidates {
            let class_match = target
                .window_classes
                .iter()
                .any(|expected| candidate.class.eq_ignore_ascii_case(expected));
            let title_match = match target.title_contains {
                Some(needle) => candidate.title.to_lowercase().contains(needle),
                None => !candidate.title.is_empty(),
            };
            if class_match && title_match {
                return Some((
                    candidate.hwnd,
                    candidate.class.clone(),
                    candidate.title.clone(),
                    started.elapsed().as_millis(),
                ));
            }
        }
        if started.elapsed() >= timeout {
            return None;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn bstr_to_string(value: windows::core::Result<BSTR>) -> String {
    value.map(|text| text.to_string()).unwrap_or_default()
}

/// Walks the whole accessibility subtree and records how targetable it is.
pub fn probe_uia(hwnd: HWND, finding: &mut Finding, allow_input: bool, input_probe: bool) {
    let automation: IUIAutomation = match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
        Ok(value) => value,
        Err(error) => {
            finding.errors.push(format!("CoCreateInstance(CUIAutomation) failed: {error}"));
            return;
        }
    };

    let root: IUIAutomationElement = match unsafe { automation.ElementFromHandle(hwnd) } {
        Ok(element) => element,
        Err(error) => {
            finding.errors.push(format!("ElementFromHandle failed: {error}"));
            return;
        }
    };
    finding.uia_root_name = bstr_to_string(unsafe { root.CurrentName() });

    let started = Instant::now();
    let condition = match unsafe { automation.CreateTrueCondition() } {
        Ok(condition) => condition,
        Err(error) => {
            finding.errors.push(format!("CreateTrueCondition failed: {error}"));
            return;
        }
    };
    let elements = match unsafe { root.FindAll(TreeScope_Subtree, &condition) } {
        Ok(elements) => elements,
        Err(error) => {
            finding.errors.push(format!("FindAll(subtree) failed: {error}"));
            return;
        }
    };
    let count = unsafe { elements.Length() }.unwrap_or(0);
    finding.subtree_elements = count.max(0) as usize;

    let mut first_editable: Option<IUIAutomationElement> = None;
    for index in 0..count {
        let Ok(element) = (unsafe { elements.GetElement(index) }) else { continue };
        if !bstr_to_string(unsafe { element.CurrentAutomationId() }).is_empty() {
            finding.elements_with_automation_id += 1;
        }
        let control_type = unsafe { element.CurrentControlType() }.unwrap_or_default();
        let clickable_type = control_type == UIA_ButtonControlTypeId
            || control_type == UIA_MenuItemControlTypeId
            || control_type == UIA_ListItemControlTypeId
            || control_type == UIA_TabItemControlTypeId;
        let invokable =
            clickable_type && unsafe { element.GetCurrentPattern(UIA_InvokePatternId) }.is_ok();
        if invokable {
            finding.invokable_elements += 1;
        }
        if control_type == UIA_EditControlTypeId {
            finding.editable_elements += 1;
            if first_editable.is_none() {
                first_editable = Some(element);
            }
        }
    }
    finding.tree_walk_ms = started.elapsed().as_millis();

    if !allow_input || !input_probe {
        finding
            .notes
            .push("Write probe skipped. Re-run with --allow-input to attempt a ValuePattern write.".into());
        return;
    }

    match first_editable {
        None => finding.notes.push("No edit control exposed, so no write probe was possible.".into()),
        Some(element) => {
            let pattern = unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) };
            match pattern {
                Ok(value_pattern) => {
                    let text = BSTR::from("jarvis computer-use spike");
                    match unsafe { value_pattern.SetValue(&text) } {
                        Ok(()) => {
                            finding.value_pattern_write = Some(true);
                            finding.notes.push("ValuePattern.SetValue succeeded on the first edit control.".into());
                        }
                        Err(error) => {
                            finding.value_pattern_write = Some(false);
                            finding.errors.push(format!("ValuePattern.SetValue failed: {error}"));
                        }
                    }
                }
                Err(error) => {
                    finding.value_pattern_write = Some(false);
                    finding
                        .errors
                        .push(format!("Edit control does not implement ValuePattern: {error}"));
                }
            }
        }
    }
}

/// Captures the window with GDI so we know the coordinate fallback is viable.
pub fn capture_window(hwnd: HWND, out_dir: &Path, key: &str, finding: &mut Finding) {
    match capture_window_inner(hwnd, out_dir, key) {
        Ok((path, width, height)) => {
            finding.screenshot_ok = true;
            finding.screenshot_path = path.display().to_string();
            finding.screenshot_size = Some((width, height));
        }
        Err(error) => finding.errors.push(format!("Window capture failed: {error}")),
    }
}

fn capture_window_inner(hwnd: HWND, out_dir: &Path, key: &str) -> Result<(PathBuf, u32, u32), String> {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }.map_err(|error| error.to_string())?;
    let width = (rect.right - rect.left).max(1);
    let height = (rect.bottom - rect.top).max(1);

    unsafe {
        let window_dc = GetWindowDC(hwnd);
        if window_dc.is_invalid() {
            return Err("GetWindowDC returned an invalid handle".into());
        }
        let memory_dc = CreateCompatibleDC(window_dc);
        let bitmap = CreateCompatibleBitmap(window_dc, width, height);
        let previous = SelectObject(memory_dc, bitmap);

        let blit = BitBlt(memory_dc, 0, 0, width, height, window_dc, 0, 0, SRCCOPY);

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Negative height gives us a top-down buffer.
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buffer = vec![0u8; (width as usize) * (height as usize) * 4];
        let copied = GetDIBits(
            memory_dc,
            bitmap,
            0,
            height as u32,
            Some(buffer.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        );

        SelectObject(memory_dc, previous);
        let _ = DeleteObject(bitmap);
        let _ = DeleteDC(memory_dc);
        ReleaseDC(hwnd, window_dc);

        blit.map_err(|error| format!("BitBlt failed: {error}"))?;
        if copied == 0 {
            return Err("GetDIBits copied no scanlines".into());
        }

        // GDI leaves the alpha channel at zero, which makes viewers show nothing.
        for pixel in buffer.chunks_exact_mut(4) {
            pixel[3] = 255;
        }

        std::fs::create_dir_all(out_dir).map_err(|error| error.to_string())?;
        let path = out_dir.join(format!("{key}.bmp"));
        write_bmp(&path, width as u32, height as u32, &buffer)?;
        Ok((path, width as u32, height as u32))
    }
}

/// Writes a top-down 32-bit BMP. Hand-rolled so the spike needs no image crate.
fn write_bmp(path: &Path, width: u32, height: u32, bgra: &[u8]) -> Result<(), String> {
    let pixel_bytes = bgra.len() as u32;
    let mut file = Vec::with_capacity(bgra.len() + 54);
    file.extend_from_slice(b"BM");
    file.extend_from_slice(&(54 + pixel_bytes).to_le_bytes());
    file.extend_from_slice(&0u16.to_le_bytes());
    file.extend_from_slice(&0u16.to_le_bytes());
    file.extend_from_slice(&54u32.to_le_bytes());
    file.extend_from_slice(&40u32.to_le_bytes());
    file.extend_from_slice(&(width as i32).to_le_bytes());
    // Negative height marks the rows as top-down, matching the GetDIBits buffer.
    file.extend_from_slice(&(-(height as i32)).to_le_bytes());
    file.extend_from_slice(&1u16.to_le_bytes());
    file.extend_from_slice(&32u16.to_le_bytes());
    file.extend_from_slice(&0u32.to_le_bytes());
    file.extend_from_slice(&pixel_bytes.to_le_bytes());
    file.extend_from_slice(&[0u8; 16]);
    file.extend_from_slice(bgra);
    std::fs::write(path, file).map_err(|error| error.to_string())
}

/// Launches the target through the shell so URIs such as `ms-settings:` work.
pub fn launch(command: &str) -> Result<(), String> {
    use std::process::Command;
    Command::new("cmd")
        .args(["/C", "start", "", command])
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}
