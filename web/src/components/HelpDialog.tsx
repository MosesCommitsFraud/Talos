import { HelpCircleIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent } from './ui/dialog';

/** Placeholder Help page — content lands here later. */
export function HelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent title={t('help.title')}>
        <div className="flex flex-col items-center gap-3 px-6 py-16 text-center text-sm text-muted-foreground">
          <HelpCircleIcon className="size-6 opacity-60" />
          {t('help.empty')}
        </div>
      </DialogContent>
    </Dialog>
  );
}
