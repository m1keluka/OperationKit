import { User as UserIcon } from 'lucide-react'
import { UNASSIGNED_TOKEN } from '../lib/assigneeFilter'
import { FilterDropdown, DropdownOption } from './FilterDropdown'

interface OwnerFilterSelectProps {
  /** Usernames that own something on this board (plus the current user). */
  options: string[]
  /** Selected tokens: usernames and/or UNASSIGNED_TOKEN. */
  selected: Set<string>
  everyoneSelected: boolean
  currentUser?: string
  onToggle: (token: string) => void
  onEveryone: () => void
}

/**
 * The board's owner filter as one "Owner ▾" dropdown (obj 900666) — replaces
 * the full-width chip row from obj 700857. Still multi-select: each row
 * toggles, and "Everyone" flips between all owners and the default
 * (Unassigned + me), exactly as the chip row did.
 */
export function OwnerFilterSelect({
  options, selected, everyoneSelected, currentUser, onToggle, onEveryone,
}: OwnerFilterSelectProps) {
  const name = (token: string) =>
    token === UNASSIGNED_TOKEN ? 'Unassigned' : token === currentUser ? `${token} (me)` : token
  const picked = [UNASSIGNED_TOKEN, ...options].filter(t => selected.has(t))
  const value = everyoneSelected
    ? 'Everyone'
    : picked.length === 0
      ? 'Nobody'
      : picked.length <= 2
        ? picked.map(t => (t === currentUser ? 'Me' : t === UNASSIGNED_TOKEN ? 'Unassigned' : t)).join(' + ')
        : `${picked.length} people`

  return (
    <FilterDropdown
      testId="owner-filter"
      label="Owner"
      value={value}
      ariaLabel={`Owner filter: ${value}`}
      icon={<UserIcon className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden="true" />}
      active={!everyoneSelected}
      panelClassName="w-60"
    >
      {() => (
        <div className="max-h-72 overflow-y-auto" role="group" aria-label="Filter board by owner">
          <DropdownOption multi selected={everyoneSelected} onClick={onEveryone} data-owner="*">
            Everyone
          </DropdownOption>
          <div className="my-1 border-t border-line-soft" />
          {[UNASSIGNED_TOKEN, ...options].map(token => (
            <DropdownOption
              key={token}
              multi
              selected={selected.has(token)}
              onClick={() => onToggle(token)}
              data-owner={token}
            >
              {name(token)}
            </DropdownOption>
          ))}
        </div>
      )}
    </FilterDropdown>
  )
}
