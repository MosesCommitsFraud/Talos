import { CheckIcon } from 'lucide-react';
import type * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { Session } from '@/api/types';
import {
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubPopup,
  ContextMenuSubTrigger,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from './ui/menu';

/** The three dots and a right-click open the same menu, on two different Radix
 *  primitives. Their parts take the same props, so one tree renders on either. */
const PARTS = {
  dropdown: {
    Popup: MenuPopup,
    Item: MenuItem,
    Separator: MenuSeparator,
    Sub: MenuSub,
    SubTrigger: MenuSubTrigger,
    SubPopup: MenuSubPopup,
  },
  context: {
    Popup: ContextMenuPopup as unknown as typeof MenuPopup,
    Item: ContextMenuItem as unknown as typeof MenuItem,
    Separator: ContextMenuSeparator as unknown as typeof MenuSeparator,
    Sub: ContextMenuSub as unknown as typeof MenuSub,
    SubTrigger: ContextMenuSubTrigger as unknown as typeof MenuSubTrigger,
    SubPopup: ContextMenuSubPopup as unknown as typeof MenuSubPopup,
  },
};

export const POPUP_CLASS = 'w-56 rounded-xl p-1.5';
export const SUB_POPUP_CLASS = 'max-h-60 w-max min-w-32 max-w-56 overflow-y-auto rounded-lg p-1';
export const ITEM_CLASS = 'min-h-[30px] rounded-lg px-2.5 text-sm sm:min-h-[30px]';
export const SUB_ITEM_CLASS = 'min-h-[26px] gap-3 rounded-md px-2 text-[13px] sm:min-h-[26px] sm:text-[13px]';
export const SEPARATOR_CLASS = 'my-1.5';
const SUB_SEPARATOR_CLASS = 'my-1';

/** Pressing an item's key while its menu is open runs that item. Radix closes
 *  the menu on a click, which a plain state change could not do for a context
 *  menu. Keys from a submenu reach the parent's handler too (React events cross
 *  the portal), so each menu only answers for itself. A submenu opened with the
 *  mouse leaves focus on its trigger in the parent, so an open submenu goes first. */
function pressShortcut(event: React.KeyboardEvent<HTMLDivElement>) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
  const menu = event.currentTarget;
  if ((event.target as HTMLElement).closest('[role="menu"]') !== menu) return;
  const openSub = menu.querySelector('[aria-haspopup="menu"][data-state="open"]')?.getAttribute('aria-controls');
  const scope = (openSub && document.getElementById(openSub)) || menu;
  const item = scope.querySelector<HTMLElement>(`[data-menu-key="${CSS.escape(event.key.toLowerCase())}"]`);
  if (!item) return;
  event.preventDefault();
  item.click();
}

export interface SessionMenuActions {
  togglePin: () => void;
  toggleUnread: () => void;
  rename: () => void;
  fork: () => void;
  moveToSection: (section: string | null) => void;
  newSection: () => void;
  moveToProject: (project: string | null) => void;
  newProject: () => void;
  archive: () => void;
  remove: () => void;
}

/** Runs the action a shortcut letter stands for. The same letters work in the open
 *  menu and on a merely hovered row. Returns whether the key meant anything. */
export function runSessionShortcut(key: string, actions: SessionMenuActions, pinned: boolean): boolean {
  switch (key) {
    case 'p': actions.togglePin(); return true;
    case 'u': actions.toggleUnread(); return true;
    case 'r': actions.rename(); return true;
    case 'f': actions.fork(); return true;
    case 'a': actions.archive(); return true;
    // The server refuses to delete a pinned chat, so unpinning comes first.
    case 'd': if (!pinned) actions.remove(); return true;
    default: return false;
  }
}

/** A submenu choosing one label for the chat: every existing one, a way out when
 *  the chat has one, and a new one at the end. Rows are numbered for the keyboard. */
function LabelSubmenu({
  kind,
  label,
  options,
  current,
  noneLabel,
  newLabel,
  onPick,
  onNew,
}: {
  kind: keyof typeof PARTS;
  label: string;
  options: string[];
  current: string | null;
  noneLabel: string;
  newLabel: string;
  onPick: (value: string | null) => void;
  onNew: () => void;
}) {
  const { Item, Separator, Sub, SubTrigger, SubPopup } = PARTS[kind];
  // Only nine digits to hand out; rows past that are simply mouse-only.
  const keyAt = (index: number) => (index < 9 ? String(index + 1) : undefined);
  const row = (key: string | undefined, text: string, onSelect: () => void, checked = false) => (
    <Item key={text} className={SUB_ITEM_CLASS} data-menu-key={key} onSelect={onSelect}>
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {checked ? <CheckIcon className="size-3.5" /> : key && <MenuShortcut>{key}</MenuShortcut>}
    </Item>
  );
  const offset = current ? 1 : 0;
  return (
    <Sub>
      <SubTrigger className={ITEM_CLASS}>
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </SubTrigger>
      <SubPopup className={SUB_POPUP_CLASS} sideOffset={4} onKeyDown={pressShortcut}>
        {current && row(keyAt(0), noneLabel, () => onPick(null))}
        {options.map((name, index) =>
          row(keyAt(index + offset), name, () => onPick(name), name === current),
        )}
        {options.length + offset > 0 && <Separator className={SUB_SEPARATOR_CLASS} />}
        {row(keyAt(options.length + offset), newLabel, onNew)}
      </SubPopup>
    </Sub>
  );
}

/** The chat row's menu, rendered as the popup of whichever root it sits in. */
export function SessionMenuPopup({
  kind,
  session,
  unread,
  projects,
  sections,
  actions,
  ...popupProps
}: {
  kind: keyof typeof PARTS;
  session: Session;
  /** Marked unread, or finished in the background and not looked at yet. */
  unread: boolean;
  projects: string[];
  sections: string[];
  actions: SessionMenuActions;
} & Pick<React.ComponentProps<typeof MenuPopup>, 'align' | 'side' | 'sideOffset'>) {
  const { t } = useTranslation();
  const { Popup, Item, Separator } = PARTS[kind];
  const pinned = !!session.is_important;
  const row = (
    key: string,
    text: string,
    onSelect: () => void,
    extra?: { variant?: 'destructive'; disabled?: boolean },
  ) => (
    <Item className={ITEM_CLASS} data-menu-key={key} onSelect={onSelect} {...extra}>
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <MenuShortcut>{key.toUpperCase()}</MenuShortcut>
    </Item>
  );
  return (
    <Popup className={POPUP_CLASS} onKeyDown={pressShortcut} {...popupProps}>
      {row('p', t(pinned ? 'sidebar.unpin' : 'sidebar.pin'), actions.togglePin)}
      {row('u', t(unread ? 'sidebar.markRead' : 'sidebar.markUnread'), actions.toggleUnread)}
      {row('r', t('sidebar.rename'), actions.rename)}
      {row('f', t('sidebar.fork'), actions.fork)}
      <Separator className={SEPARATOR_CLASS} />
      <LabelSubmenu
        kind={kind}
        label={t('sidebar.moveToSection')}
        options={sections}
        current={session.section || null}
        noneLabel={t('sidebar.noSection')}
        newLabel={t('sidebar.newSection')}
        onPick={actions.moveToSection}
        onNew={actions.newSection}
      />
      <LabelSubmenu
        kind={kind}
        label={t('sidebar.moveToProject')}
        options={projects}
        current={session.folder || null}
        noneLabel={t('sidebar.noProject')}
        newLabel={t('sidebar.newProject')}
        onPick={actions.moveToProject}
        onNew={actions.newProject}
      />
      <Separator className={SEPARATOR_CLASS} />
      {row('a', t('sidebar.archive'), actions.archive)}
      {/* The server refuses to delete a pinned chat, so unpinning comes first. */}
      {row('d', t('common.delete'), actions.remove, { variant: 'destructive', disabled: pinned })}
    </Popup>
  );
}
