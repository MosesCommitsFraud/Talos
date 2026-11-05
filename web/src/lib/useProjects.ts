import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { createProject, fetchProjects, updateProject } from '@/api/client';
import { usePrefs } from '@/state/prefs';

/** The projects the signed-in user is in, as creator or member. */
export function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
}

/** Projects used to keep their description, and exist while empty, only in this
 *  browser's prefs. Whatever is still there moves to the server, once it is known
 *  what the server already has: the folders became projects there at boot, without
 *  a description. A failure leaves the prefs alone, for the next load. */
export function useMoveStoredProjects() {
  const stored = usePrefs((s) => s.projects);
  const clearStoredProjects = usePrefs((s) => s.clearStoredProjects);
  const { data: projects } = useProjects();
  const queryClient = useQueryClient();
  const moving = useRef(false);

  useEffect(() => {
    if (!projects || stored.length === 0 || moving.current) return;
    moving.current = true;
    void (async () => {
      for (const { name, description } of stored) {
        const existing = projects.find((p) => p.name === name && p.is_creator);
        if (!existing) await createProject(name, description ?? '');
        else if (description && !existing.description) await updateProject(existing.id, { description });
      }
      clearStoredProjects();
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
    })()
      .catch((err) => console.error('Talos: moving projects to the server failed', err))
      .finally(() => { moving.current = false; });
  }, [projects, stored, clearStoredProjects, queryClient]);
}
