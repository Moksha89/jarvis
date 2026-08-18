import type { IncomingMessage, ServerResponse } from 'node:http';

export type Handler = (ctx: RequestContext) => Promise<void> | void;

export interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  json: <T>() => Promise<T>;
  send: (status: number, body: unknown) => void;
}

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

/** A tiny path-parameter router; Core's surface is small enough not to need a framework. */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: Handler): void {
    this.routes.push({ method, segments: path.split('/').filter(Boolean), handler });
  }

  get(path: string, handler: Handler): void {
    this.add('GET', path, handler);
  }
  post(path: string, handler: Handler): void {
    this.add('POST', path, handler);
  }
  patch(path: string, handler: Handler): void {
    this.add('PATCH', path, handler);
  }
  delete(path: string, handler: Handler): void {
    this.add('DELETE', path, handler);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | undefined {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const segment = route.segments[index] as string;
        const value = parts[index] as string;
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(value);
        } else if (segment !== value) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return undefined;
  }
}
