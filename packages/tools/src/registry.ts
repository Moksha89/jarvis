import type { JarvisTool } from '@jarvis/types';

/**
 * A tool with its input type erased. `never` as the input keeps the registry
 * assignable from every concrete tool without resorting to `any`.
 */
export type AnyJarvisTool = JarvisTool<never, unknown>;

export class ToolRegistry {
  private readonly tools = new Map<string, AnyJarvisTool>();

  register(tool: AnyJarvisTool): void {
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool already registered: ${tool.id}`);
    }
    this.tools.set(tool.id, tool);
  }

  get(id: string): AnyJarvisTool | undefined {
    return this.tools.get(id);
  }

  require(id: string): AnyJarvisTool {
    const tool = this.tools.get(id);
    if (!tool) throw new Error(`Unknown tool: ${id}`);
    return tool;
  }

  list(): AnyJarvisTool[] {
    return [...this.tools.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
