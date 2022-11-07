import classNames from "classnames";
import { forwardRef } from "react";

export interface CheckboxProps {
  id?: string;
  name?: string;
  className?: string;
  placeholder?: string;
  checked?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, disabled, ...props }, ref) => {
    return (
      <input
        ref={ref}
        type="checkbox"
        className={classNames(
          "h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500 transition ease-in-out",
          disabled && "cursor-not-allowed opacity-50",
          className,
        )}
        disabled={disabled}
        {...props}
      />
    );
  },
);
