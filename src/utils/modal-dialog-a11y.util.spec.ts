import { describe, expect, it } from 'vitest';
import { buildModalDialogAriaProps } from './modal-dialog-a11y.util';

describe('buildModalDialogAriaProps (#313)', () => {
  it('computes ARIA dialog attributes for modal accessibility', () => {
    expect(buildModalDialogAriaProps('modal-title', 'modal-desc')).toEqual({
      role: 'dialog',
      'aria-modal': true,
      'aria-labelledby': 'modal-title',
      'aria-describedby': 'modal-desc',
    });
  });
});
