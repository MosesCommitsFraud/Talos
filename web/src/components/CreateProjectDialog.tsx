import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createProject } from '@/api/client';
import { useProjects } from '@/lib/useProjects';
import { useUi } from '@/state/ui';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogSection } from './ui/dialog';

/** "Create a project": a name and what it is for. Whoever creates it manages who
 *  else is in it. Opens the new project's page right away. */
export function CreateProjectDialog() {
  const { t } = useTranslation();
  const open = useUi((s) => s.createProjectOpen);
  const setOpen = useUi((s) => s.setCreateProjectOpen);
  const setOpenProject = useUi((s) => s.setOpenProject);
  const setView = useUi((s) => s.setView);
  const { data: projects } = useProjects();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  // Fresh fields each time it opens — a half-typed name from last time reads
  // as a draft the dialog is about to save.
  useEffect(() => {
    if (open) { setName(''); setDescription(''); }
  }, [open]);

  const trimmed = name.trim();
  const duplicate = (projects ?? []).some((p) => p.name === trimmed && p.is_creator);
  const creating = useMutation({
    mutationFn: () => createProject(trimmed, description.trim()),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      setOpenProject(project.id);
      setView('projects');
      setOpen(false);
    },
  });
  const canCreate = !!trimmed && !duplicate && !creating.isPending;

  const create = () => {
    if (canCreate) creating.mutate();
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
          {creating.error && (
            <p role="alert" className="text-xs text-destructive-foreground">{(creating.error as Error).message}</p>
          )}
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
