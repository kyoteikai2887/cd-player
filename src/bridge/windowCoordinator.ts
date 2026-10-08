import type {
  ActionResult,
  HostInfo,
  Surface,
  WindowMode,
} from "../contracts/player.ts";
import type { DispatchContext } from "./boundedDispatch.ts";
import { createExitGuard } from "./exitGuard.ts";
import { fitMiniWindow } from "../core/windowGeometry.ts";
import type { WindowRect } from "../core/windowGeometry.ts";

export type WindowObservation = Omit<HostInfo, "windowMode" | "coreStatus">;

/** Private adapter boundary. Observations describe effective OS state, including fallbacks.
 * show resolves after visibility is acknowledged; hide keeps the webview and its drafts alive.
 * Every adapter call must honor AbortSignal before a native mutation. No destroy API is exposed.
 */
export interface NativeWindowPort {
  shell: HostInfo["shell"];
  observe(surface: Surface): Omit<WindowObservation, "shell">;
  show(surface: Surface, signal: AbortSignal): Promise<void>;
  hide(surface: Surface, signal: AbortSignal): Promise<void>;
  miniBounds(): Promise<{ current: WindowRect; workArea: WindowRect }>;
  resizeMini(bounds: WindowRect, signal: AbortSignal): Promise<void>;
  confirmDiscard(): Promise<boolean>;
  exit(): Promise<void>;
}

const applied: ActionResult = { ok: true, status: "applied" };
const unavailable = (message: string): ActionResult => ({
  ok: false,
  code: "unavailable",
  message,
});

/** Process-owned policy, reusable by a future native host. It owns neither audio nor UI drafts. */
export function createWindowCoordinator(
  port: NativeWindowPort,
  onChange: () => void,
  initialMode: WindowMode = "full",
) {
  let mode = initialMode;
  let tail: Promise<unknown> = Promise.resolve();
  let exitRequest: Promise<boolean> | null = null;
  const dirty = createExitGuard();
  const exclusive = (
    context: DispatchContext,
    operation: () => Promise<ActionResult>,
  ) => {
    const pending = tail.then(async () => {
      if (!context.isActive()) return unavailable("窗口操作已取消。");
      try {
        return await operation();
      } catch {
        return unavailable("窗口操作未完成，请重试。");
      } finally {
        onChange();
      }
    });
    tail = pending.catch(() => {});
    return pending;
  };
  return {
    host(surface: Surface): HostInfo {
      return {
        shell: port.shell,
        ...port.observe(surface),
        windowMode: mode,
        coreStatus: "ready",
      };
    },
    setMode(next: WindowMode, context: DispatchContext): Promise<ActionResult> {
      return exclusive(context, async () => {
        const target: Surface = next === "full" ? "main" : "mini";
        const old: Surface = target === "main" ? "mini" : "main";
        if (!port.observe(target).surfaceVisible)
          await port.show(target, context.signal);
        if (!context.isActive()) return unavailable("窗口操作已取消。");
        if (!port.observe(target).surfaceVisible)
          return unavailable("目标窗口尚未显示。");
        mode = next;
        onChange();
        if (port.observe(old).surfaceVisible)
          await port.hide(old, context.signal);
        return context.isActive() ? applied : unavailable("窗口操作已取消。");
      });
    },
    hideToTray(context: DispatchContext): Promise<ActionResult> {
      return exclusive(context, async () => {
        for (const surface of ["main", "mini"] as const) {
          if (!context.isActive()) return unavailable("窗口操作已取消。");
          if (port.observe(surface).surfaceVisible)
            await port.hide(surface, context.signal);
        }
        return context.isActive() ? applied : unavailable("窗口操作已取消。");
      });
    },
    resizeMini(
      size: Pick<WindowRect, "width" | "height">,
      context: DispatchContext,
    ): Promise<ActionResult> {
      return exclusive(context, async () => {
        const { current, workArea } = await port.miniBounds();
        if (!context.isActive()) return unavailable("窗口操作已取消。");
        const bounds = fitMiniWindow(current, size, workArea);
        await port.resizeMini(bounds, context.signal);
        return context.isActive() ? applied : unavailable("窗口操作已取消。");
      });
    },
    reportUnsavedChanges: dirty.report,
    hasUnsavedChanges: dirty.hasUnsavedChanges,
    requestExit(): Promise<boolean> {
      if (exitRequest) return exitRequest;
      exitRequest = (async () => {
        await tail;
        if (!(await dirty.requestExit(() => port.confirmDiscard())))
          return false;
        // Reuse the same promise so repeated tray clicks never invoke exit twice.
        try {
          await port.exit();
          return true;
        } catch {
          return false;
        }
      })().finally(() => {
        exitRequest = null;
      });
      return exitRequest;
    },
  };
}
