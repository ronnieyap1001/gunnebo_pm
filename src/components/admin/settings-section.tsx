import { cn } from "@/lib/utils";

/** A titled group of settings rows (a card). */
export function SettingsGroup({
  id,
  title,
  description,
  children,
  className,
}: {
  id: string;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn("scroll-mt-4 space-y-2", className)}>
      <div>
        <h2 id={`${id}-title`} className="text-sm font-semibold">
          {title}
        </h2>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="divide-y rounded-xl border bg-card">{children}</div>
    </section>
  );
}

/** One setting: label and help on the left, the control on the right (stacked on narrow screens). */
export function SettingsRow({
  title,
  description,
  children,
  below,
  htmlFor,
}: {
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Full-width content under the row (results, warnings). */
  below?: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:gap-6">
        <div className="min-w-0 md:w-80 md:shrink-0">
          {htmlFor ? (
            <label htmlFor={htmlFor} className="text-sm font-medium">
              {title}
            </label>
          ) : (
            <h3 className="text-sm font-medium">{title}</h3>
          )}
          {description ? <div className="mt-0.5 text-xs text-muted-foreground">{description}</div> : null}
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 md:justify-end">{children}</div>
      </div>
      {below ? <div className="mt-3">{below}</div> : null}
    </div>
  );
}
