import { forwardRef } from 'react';
import { inputClass, mergeClass } from './form-styles';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, mono, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={mergeClass(inputClass, mono && 'font-mono', className)}
      {...props}
    />
  );
});
