export interface ModalDialogAriaProps {
  role: 'dialog';
  'aria-modal': boolean;
  'aria-labelledby': string;
  'aria-describedby': string;
}

export function buildModalDialogAriaProps(
  titleId: string,
  descriptionId: string,
): ModalDialogAriaProps {
  return {
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': titleId,
    'aria-describedby': descriptionId,
  };
}
