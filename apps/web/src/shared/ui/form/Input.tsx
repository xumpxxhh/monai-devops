import { forwardRef } from 'react';
import { useFieldId } from './field-context';
import { inputClass, mergeClass } from './form-styles';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, mono, id, ...props },
  ref,
) {
  const fieldId = useFieldId();

  return (
    <input
      ref={ref}
      id={id ?? fieldId}
      className={mergeClass(inputClass, mono && 'font-mono', className)}
      {...props}
    />
  );
});
