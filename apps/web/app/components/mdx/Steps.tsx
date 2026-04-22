import { Children, isValidElement, type ReactElement, type ReactNode } from "react"

interface StepsProps {
  readonly children: ReactNode
}

interface StepProps {
  readonly title: string
  readonly children: ReactNode
}

export function Steps({ children }: StepsProps) {
  const steps = Children.toArray(children).filter((child): child is ReactElement<StepProps> =>
    isValidElement(child),
  )
  return (
    <ol className="my-8 space-y-6 list-none pl-0">
      {steps.map((step, i) => (
        <li key={step.props.title ?? i} className="flex gap-5 items-start">
          <span className="w-7 h-7 rounded-full bg-accent-amber/15 border border-accent-amber/40 text-accent-amber flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
            {i + 1}
          </span>
          <div className="flex-1 min-w-0">{step}</div>
        </li>
      ))}
    </ol>
  )
}

export function Step({ title, children }: StepProps) {
  return (
    <>
      <p className="text-base font-semibold text-text-primary mb-2">{title}</p>
      <div className="text-sm text-text-secondary leading-relaxed [&>p]:m-0 [&>p+*]:mt-3 [&>pre]:mt-3 [&>ul]:mt-3 [&>ol]:mt-3">
        {children}
      </div>
    </>
  )
}
