import { ConfigService } from '@nestjs/config';
import { PdfVisualService } from '../src/modules/documents/parsers/pdf-visual.service';
const visual = new PdfVisualService(new ConfigService(), {} as any, {} as any) as any;
it('accepts empty optional OCR rows without discarding valid content', () => {
  expect(
    visual.blocks({
      blocks: [
        { type: 'ocr', text: '' },
        { type: 'figure', text: 'A → B' },
      ],
    }),
  ).toEqual([{ type: 'figure', text: 'A → B' }]);
});
it('keeps rejecting unknown types and missing structures with useful schema details', () => {
  expect(() => visual.blocks({ blocks: [{ type: 'bogus', text: 'A' }] })).toThrow(/blocks\[0\]/);
  expect(() => visual.blocks({ unexpected: [] })).toThrow(/blocks/);
});
