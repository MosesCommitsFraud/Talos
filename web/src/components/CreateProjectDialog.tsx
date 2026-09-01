import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePrefs } from '@/state/prefs';
import { useUi } from '@/state/ui';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogSection } from './ui/dialog';

/** "Create a project": a name and what the project is for. Both live in prefs —
 *  the server only ever learns the name, and only once a chat is moved into the
 *  project (a project is a folder label on its chats). Creating one therefore
 *  can't fail, and opens the new, empty project right away. */
export function CreateProjectDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.createProjectOpen);
  const setOpen = useUi((s) => s.setCreateProjectOpen);
  const setOpenProject = useUi((s) => s.setOpenProject);
  const setView = useUi((s) => s.setView);
  const projects = usePrefs((s) => s.projects);
  const addProject = usePrefs((s) => s.addProject);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // Fresh fields each time it opens — a half-typed name from last time reads
  // as a draft the dialog is about to save.
  useEffect(() => {
    if (open) { setName(''); setDescription(''); }
  }, [open]);

  const trimmed = name.trim();
  const duplicate = projects.some((p) => p.name === trimmed);
  const canCreate = !!trimmed && !duplicate;

  const create = () => {
    if (!canCreate) return;
    addProject(trimmed, description.trim() || undefined);
    setOpenProject(trimmed);
    setView('projects');
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title={t('projects.createTitle')} className="w-[min(520px,92vw)]">
        <DialogSection className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="project-name" className="block text-sm font-medium text-foreground">
              {t('projects.nameLabel')}
            </label>
            <input
              id="project-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
              placeholder={t('projects.namePlaceholder')}
              className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-shadow focus:border-ring focus:ring-[3px] focus:ring-ring/25 dark:bg-input/20"
            />
            {duplicate && (
              <p className="text-xs text-destructive-foreground">{t('projects.duplicate')}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="project-goal" className="block text-sm font-medium text-foreground">
              {t('projects.goalLabel')}
            </label>
            <textarea
              id="project-goal"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('projects.goalPlaceholder')}
              className="w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-shadow focus:border-ring focus:ring-[3px] focus:ring-ring/25 dark:bg-input/20"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={create} disabled={!canCreate}>
              {t('projects.create')}
            </Button>
          </div>
        </DialogSection>
      </DialogContent>
    </Dialog>
  );
}
