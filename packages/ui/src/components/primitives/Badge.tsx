import { forwardRef, type HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn.js';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0 text-caption font-medium leading-4 transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'border-border text-muted-foreground',
        success: 'border-transparent bg-emerald-500/15 text-emerald-300',
        warning: 'border-transparent bg-amber-500/15 text-amber-300',
        info: 'border-transparent bg-accent/40 text-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <span ref={ref} className={cn(badgeVariants({ variant, className }))} {...props} />
  ),
);
Badge.displayName = 'Badge';

export { badgeVariants };
