import { forwardRef } from 'react';
import { mergeClass, textareaClass } from './form-styles';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, mono, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={mergeClass(textareaClass, mono && 'font-mono text-xs', className)}
      {...props}
    />
  );
});
