import React, { useCallback, useEffect, useRef } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * A bottom action sheet — the small panel that slides up when a choice needs
 * explaining rather than guessing.
 *
 * It exists because destructive actions should not live next to the button you
 * tap casually: "Leave" and "End for everyone" are one deliberate tap apart,
 * with a line of text each, instead of two pills side by side in a control bar.
 *
 * Accessibility: it is a modal dialog, Escape and the backdrop close it, focus
 * moves to the first choice on open, Tab stays inside, and focus returns to
 * whatever opened it on close.
 */

export type SheetTone = "default" | "danger" | "warning";

export interface SheetAction {
  id: string;
  label: string;
  description?: string;
  icon: LucideIcon;
  tone?: SheetTone;
  onSelect: () => void;
}

interface ActionSheetProps {
  open: boolean;
  title: string;
  description?: string;
  actions: SheetAction[];
  cancelLabel?: string;
  onClose: () => void;
}

const TONE: Record<
  SheetTone,
  { text: string; background: string; border: string; iconBackground: string; icon: string }
> = {
  default: {
    text: "#ffffff",
    background: "rgba(255,255,255,0.06)",
    border: "rgba(255,255,255,0.10)",
    iconBackground: "rgba(255,255,255,0.12)",
    icon: "#ffffff",
  },
  danger: {
    text: "#fca5a5",
    background: "rgba(239,68,68,0.12)",
    border: "rgba(239,68,68,0.38)",
    iconBackground: "rgba(239,68,68,0.18)",
    icon: "#f87171",
  },
  warning: {
    text: "#fbbf24",
    background: "rgba(245,158,11,0.10)",
    border: "rgba(245,158,11,0.32)",
    iconBackground: "rgba(245,158,11,0.16)",
    icon: "#fbbf24",
  },
};

export function ActionSheet({
  open,
  title,
  description,
  actions,
  cancelLabel = "Cancel",
  onClose,
}: ActionSheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const firstActionRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<Element | null>(null);

  // Escape closes, and focus is parked on the first choice while open so a
  // keyboard or screen-reader user is not left behind the overlay.
  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement;
    const focusTimer = window.setTimeout(() => firstActionRef.current?.focus(), 30);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;

      // Keep Tab inside the sheet.
      const focusable = [
        ...panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      const target = previouslyFocused.current;
      if (target instanceof HTMLElement) target.focus();
    };
  }, [open, onClose]);

  const handleBackdrop = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) onClose();
    },
    [onClose],
  );

  if (!open) return null;

  return (
    <div
      className="sheet-backdrop"
      onMouseDown={handleBackdrop}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 120,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
      }}
      data-testid="action-sheet-backdrop"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="action-sheet-title"
        className="sheet-panel"
        style={{
          width: "100%",
          maxWidth: "520px",
          background: "#14141f",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          borderTopLeftRadius: "22px",
          borderTopRightRadius: "22px",
          padding: "8px 12px calc(14px + env(safe-area-inset-bottom, 0px))",
          boxShadow: "0 -12px 40px rgba(0,0,0,0.55)",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: "40px",
            height: "4px",
            borderRadius: "2px",
            background: "rgba(255,255,255,0.18)",
            margin: "2px auto 6px",
          }}
        />

        <div style={{ padding: "0 8px" }}>
          <h2
            id="action-sheet-title"
            style={{ margin: 0, color: "#fff", fontSize: "17px", fontWeight: 700, textAlign: "center" }}
          >
            {title}
          </h2>
          {description && (
            <p
              style={{
                margin: "6px 0 0",
                color: "rgba(255,255,255,0.5)",
                fontSize: "13px",
                lineHeight: 1.45,
                textAlign: "center",
              }}
            >
              {description}
            </p>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "4px" }}>
          {actions.map((action, index) => {
            const tone = TONE[action.tone ?? "default"];
            const Icon = action.icon;
            return (
              <button
                key={action.id}
                ref={index === 0 ? firstActionRef : undefined}
                type="button"
                onClick={() => {
                  // Close first: the action may unmount this sheet.
                  onClose();
                  action.onSelect();
                }}
                className="sheet-action"
                data-testid={`sheet-action-${action.id}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "14px",
                  width: "100%",
                  minHeight: "64px",
                  padding: "12px 16px",
                  borderRadius: "16px",
                  border: `1px solid ${tone.border}`,
                  background: tone.background,
                  color: tone.text,
                  textAlign: "left",
                  cursor: "pointer",
                  font: "inherit",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: "38px",
                    height: "38px",
                    flex: "0 0 auto",
                    borderRadius: "50%",
                    background: tone.iconBackground,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon style={{ width: "19px", height: "19px", color: tone.icon }} aria-hidden="true" />
                </span>
                <span style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
                  <span style={{ fontSize: "15px", fontWeight: 600, lineHeight: 1.2 }}>{action.label}</span>
                  {action.description && (
                    <span
                      style={{
                        fontSize: "12.5px",
                        fontWeight: 400,
                        color: "rgba(255,255,255,0.45)",
                        lineHeight: 1.35,
                      }}
                    >
                      {action.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="sheet-cancel"
          data-testid="sheet-cancel"
          style={{
            width: "100%",
            minHeight: "52px",
            marginTop: "2px",
            borderRadius: "16px",
            border: "none",
            background: "transparent",
            color: "rgba(255,255,255,0.65)",
            fontSize: "15px",
            fontWeight: 600,
            cursor: "pointer",
            font: "inherit",
          }}
        >
          {cancelLabel}
        </button>

        <style>{`
          .sheet-backdrop { animation: sheet-fade 0.16s ease-out; }
          .sheet-panel { animation: sheet-rise 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
          .sheet-action:active { transform: scale(0.985); }
          .sheet-action:focus-visible,
          .sheet-cancel:focus-visible {
            outline: 2px solid #9580ff;
            outline-offset: 2px;
          }
          @keyframes sheet-fade { from { opacity: 0 } to { opacity: 1 } }
          @keyframes sheet-rise { from { transform: translateY(16px); opacity: 0 } to { transform: none; opacity: 1 } }
          @media (prefers-reduced-motion: reduce) {
            .sheet-backdrop, .sheet-panel { animation: none; }
          }
        `}</style>
      </div>
    </div>
  );
}

export default ActionSheet;
