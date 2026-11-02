/**
 * Arrow-key handling for a row of `role="radio"` buttons (status chips): ←/→ (or ↑/↓) pick the previous / next
 * option, Home / End the first / last, and focus follows, as the ARIA radio group pattern expects. Only the selected
 * option is in the Tab order (`tabIndex={on ? 0 : -1}`).
 */
export function onRadioKeyDown<T>(e: React.KeyboardEvent<HTMLElement>, ids: readonly T[], current: T, select: (id: T) => void): void {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const n = ids.length;
  const i = Math.max(0, ids.indexOf(current));
  let next = -1;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % n;
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + n) % n;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = n - 1;
  if (next < 0) return;
  e.preventDefault();
  select(ids[next]);
  const group = e.currentTarget.closest("[role='radiogroup']");
  group?.querySelectorAll<HTMLElement>("[role='radio']")[next]?.focus();
}
