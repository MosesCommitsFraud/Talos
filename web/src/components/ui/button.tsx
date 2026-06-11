import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/* MIDA-derived button: subtle inset top-light on filled variants, alpha
   borders on outline, ghost = accent wash. Primary is the Talos blue. */
const buttonVariants = cva(
  'relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg border font-medium text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4',
  {
    defaultVariants: { size: 'default', variant: 'default' },
    variants: {
      size: {
        default: 'h-8 px-3',
        sm: 'h-7 gap-1.5 px-2.5',
        lg: 'h-9 px-3.5',
        icon: 'size-8',
        'icon-sm': 'size-7',
        'icon-lg': 'size-9',
      },
      variant: {
        default:
          'border-primary bg-primary text-primary-foreground shadow-xs inset-shadow-[0_1px_rgb(255_255_255/16%)] hover:bg-primary/90 active:inset-shadow-[0_1px_rgb(0_0_0/8%)]',
        destructive:
          'border-destructive bg-destructive text-white shadow-xs inset-shadow-[0_1px_rgb(255_255_255/16%)] hover:bg-destructive/90',
        'destructive-outline':
          'border-input bg-popover text-destructive-foreground shadow-xs/5 hover:border-destructive/40 hover:bg-destructive/5 dark:bg-input/30',
        outline:
          'border-input bg-popover text-foreground shadow-xs/5 hover:bg-accent dark:bg-input/30 dark:hover:bg-input/60',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'border-transparent text-foreground hover:bg-accent',
        'ghost-muted':
          'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
      },
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, type, ...props }: ButtonProps) {
  return (
    <button type={type ?? 'button'} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}

export { buttonVariants };
