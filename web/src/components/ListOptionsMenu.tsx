import { CheckIcon, ListFilterIcon } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { usePrefs, type ListGroup, type SortMode } from '@/state/prefs';
import {
  ITEM_CLASS,
  POPUP_CLASS,
  SEPARATOR_CLASS,
  SUB_ITEM_CLASS,
  SUB_POPUP_CLASS,
} from './SessionMenu';
import { Tooltip } from './ui/misc';
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from './ui/menu';

const SORT_KEYS: Record<SortMode, string> = {
  active: 'sidebar.sortActive',
  newest: 'sidebar.sortNewest',
  name: 'sidebar.sortName',
};

const GROUP_KEYS: Record<ListGroup, string> = {
  section: 'sidebar.groupSection',
  none: 'sidebar.groupNone',
};

/** A submenu row: its label, and a check when it is the current choice. */
function Choice({
  label,
  checked,
  keepOpen,
  onPick,
}: {
  label: string;
  checked: boolean;
  /** For toggles, where several can be flipped in one go. */
  keepOpen?: boolean;
  onPick: () => void;
}) {
  return (
    <MenuItem
      className={SUB_ITEM_CLASS}
      onSelect={(event) => {
        if (keepOpen) event.preventDefault();
        onPick();
      }}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <CheckIcon className={cn('size-3.5', !checked && 'invisible')} />
    </MenuItem>
  );
}

/** A top-level row opening a submenu, with the current value beside its label. */
function SubRow({ label, value, children }: { label: string; value?: string; children: React.ReactNode }) {
  return (
    <MenuSub>
      <MenuSubTrigger className={ITEM_CLASS}>
        <span className="flex-1 whitespace-nowrap pe-4">{label}</span>
        {value && <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{value}</span>}
      </MenuSubTrigger>
      <MenuSubPopup className={SUB_POPUP_CLASS} sideOffset={4}>
        {children}
      </MenuSubPopup>
    </MenuSub>
  );
}

/** What the filter icon on a chat list header opens. Sorting belongs to the list
 *  it was opened on (a section can have its own order); grouping and what is shown
 *  apply to the whole sidebar. */
export function ListOptionsMenu({
  sortMode,
  onSortChange,
  onNewSection,
  onViewAll,
  canViewAll,
  className,
}: {
  sortMode: SortMode;
  onSortChange: (mode: SortMode) => void;
  onNewSection: () => void;
  onViewAll: () => void;
  /** Something is folded away, filtered out or behind "show more". */
  canViewAll: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const listGroup = usePrefs((s) => s.listGroup);
  const showForks = usePrefs((s) => s.showForks);
  const showEmptySections = usePrefs((s) => s.showEmptySections);
  const unreadOnly = usePrefs((s) => s.unreadOnly);
  const setListOptions = usePrefs((s) => s.setListOptions);
  const resetListOptions = usePrefs((s) => s.resetListOptions);
  const isDefault = usePrefs(
    (s) =>
      s.sortMode === 'active'
      && Object.keys(s.sectionSort).length === 0
      && s.listGroup === 'section'
      && s.showForks
      && s.showEmptySections
      && !s.unreadOnly,
  );
  // "New section" opens an input elsewhere. Only once the menu has fully closed:
  // until then its focus trap pulls focus straight back out of a new input.
  const newSectionPending = useRef(false);

  return (
    <Menu>
      <Tooltip label={t('sidebar.listOptions')}>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label={t('sidebar.listOptions')}
            className={cn(
              // aria-expanded, not data-state: the tooltip wrapped around this
              // button writes its own open/closed state into that attribute.
              'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground aria-expanded:bg-foreground/10 aria-expanded:text-foreground',
              className,
            )}
          >
            <ListFilterIcon className="size-3.5" />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuPopup
        align="start"
        className={cn(POPUP_CLASS, 'w-max min-w-56')}
        onCloseAutoFocus={(event) => {
          if (!newSectionPending.current) return;
          newSectionPending.current = false;
          event.preventDefault();
          onNewSection();
        }}
      >
        <SubRow label={t('sidebar.groupBy')} value={t(GROUP_KEYS[listGroup])}>
          {(Object.keys(GROUP_KEYS) as ListGroup[]).map((option) => (
            <Choice
              key={option}
              label={t(GROUP_KEYS[option])}
              checked={option === listGroup}
              onPick={() => setListOptions({ listGroup: option })}
            />
          ))}
        </SubRow>
        <SubRow label={t('sidebar.sortBy')} value={t(SORT_KEYS[sortMode])}>
          {(Object.keys(SORT_KEYS) as SortMode[]).map((option) => (
            <Choice
              key={option}
              label={t(SORT_KEYS[option])}
              checked={option === sortMode}
              onPick={() => onSortChange(option)}
            />
          ))}
        </SubRow>
        <SubRow label={t('sidebar.show')}>
          <Choice
            keepOpen
            label={t('sidebar.showForksOption')}
            checked={showForks}
            onPick={() => setListOptions({ showForks: !showForks })}
          />
          <Choice
            keepOpen
            label={t('sidebar.showEmptySections')}
            checked={showEmptySections}
            onPick={() => setListOptions({ showEmptySections: !showEmptySections })}
          />
          <Choice
            keepOpen
            label={t('sidebar.showUnreadOnly')}
            checked={unreadOnly}
            onPick={() => setListOptions({ unreadOnly: !unreadOnly })}
          />
        </SubRow>
        <MenuSeparator className={SEPARATOR_CLASS} />
        <MenuItem
          className={ITEM_CLASS}
          onSelect={() => {
            newSectionPending.current = true;
          }}
        >
          {t('sidebar.newSection')}
        </MenuItem>
        <MenuSeparator className={SEPARATOR_CLASS} />
        <MenuItem className={ITEM_CLASS} disabled={isDefault} onSelect={resetListOptions}>
          {t('sidebar.resetDefaults')}
        </MenuItem>
        <MenuItem className={ITEM_CLASS} disabled={!canViewAll} onSelect={onViewAll}>
          {t('sidebar.viewAll')}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
