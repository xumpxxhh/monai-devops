import { forwardRef } from 'react';
import { useFieldId } from './field-context';
import { mergeClass, textareaClass } from './form-styles';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, mono, id, ...props },
  ref,
) {
  const fieldId = useFieldId();

  return (
    <textarea
      ref={ref}
      id={id ?? fieldId}
      className={mergeClass(textareaClass, mono && 'font-mono text-xs', className)}
      {...props}
    />
  );
});
