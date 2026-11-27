import { useLingui } from "@lingui/react/macro";
import type { BotAccessLevel, GrantableBot } from "@rakazo/contracts";
import {
  BotAvatar,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ListSearchInput,
  OptionSelect,
} from "@rakazo/ui-web";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

type Access = BotAccessLevel | "none";

/** Past this many bots the list gets a search field. */
const SEARCH_FROM = 7;

/**
 * Which of the viewer's bots someone may use, grouped by Space. One select per bot, so giving,
 * changing and taking back access are the same control; "Set all" changes every bot shown at once.
 */
export function BotAccessList({
  bots,
  levelOf,
  personName,
  disabled,
  onChange,
}: {
  bots: readonly GrantableBot[];
  levelOf: (botId: string) => BotAccessLevel | null;
  personName: string;
  disabled?: boolean;
  onChange: (changes: { botId: string; level: BotAccessLevel | null }[]) => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const options: { value: Access; label: string }[] = [
    { value: "none", label: t`No access` },
    { value: "chat", label: t`Can chat` },
    { value: "manage", label: t`Can manage` },
  ];
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? bots.filter((bot) => `${bot.name} ${bot.spaceName ?? ""}`.toLowerCase().includes(needle))
    : bots;
  const granted = bots.filter((bot) => levelOf(bot.id)).length;
  // A team with several Spaces sees its bots under each Space's name.
  const groups = new Map<string, GrantableBot[]>();
  for (const bot of shown) {
    const key = bot.spaceName ?? "";
    groups.set(key, [...(groups.get(key) ?? []), bot]);
  }
  const named = groups.size > 1;
  const setAll = (level: BotAccessLevel | null) =>
    onChange(
      shown.filter((bot) => levelOf(bot.id) !== level).map((bot) => ({ botId: bot.id, level })),
    );

  return (
    <div className="flex flex-col gap-4" data-testid="bot-access">
      <div className="flex flex-wrap items-center gap-2">
        {bots.length >= SEARCH_FROM ? (
          <div className="min-w-48 flex-1">
            <ListSearchInput
              query={query}
              setQuery={setQuery}
              label={t`Search bots`}
              placeholder={t`Search bots`}
            />
          </div>
        ) : (
          <span className="flex-1" />
        )}
        <span className="text-body-sm text-muted-foreground tabular-nums">
          {t`${granted} of ${bots.length} bots`}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={disabled || shown.length === 0}
            render={<Button variant="outline" size="sm" />}
          >
            {needle ? t`Set shown` : t`Set all`}
            <ChevronDown aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {options.map((option) => (
              <DropdownMenuItem
                key={option.value}
                onClick={() => setAll(option.value === "none" ? null : option.value)}
              >
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {shown.length === 0 ? (
        <p className="py-6 text-center text-body-sm text-muted-foreground">{t`No bots match`}</p>
      ) : (
        [...groups].map(([space, members]) => (
          <section
            key={space}
            aria-label={named && space ? space : undefined}
            className="flex flex-col gap-2"
          >
            {named && space ? (
              <h4 className="px-1 text-label text-muted-foreground">{space}</h4>
            ) : null}
            <ul className="grid gap-2 lg:grid-cols-2">
              {members.map((bot) => (
                <li
                  key={bot.id}
                  className="flex min-w-0 items-center gap-3 rounded-xl border border-border px-3 py-2"
                >
                  <BotAvatar
                    identity={bot.id}
                    color={bot.color}
                    avatarSet={bot.avatarSet}
                    size={28}
                  />
                  <span className="min-w-0 flex-1 truncate text-body text-foreground">
                    {bot.name}
                  </span>
                  <OptionSelect<Access>
                    aria-label={t`${personName}'s access to ${bot.name}`}
                    size="sm"
                    className="w-32 shrink-0"
                    value={levelOf(bot.id) ?? "none"}
                    disabled={disabled}
                    onValueChange={(value) =>
                      onChange([{ botId: bot.id, level: value === "none" ? null : value }])
                    }
                    options={options}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
