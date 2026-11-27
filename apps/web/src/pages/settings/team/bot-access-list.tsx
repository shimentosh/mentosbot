import { useLingui } from "@lingui/react/macro";
import type { BotAccessLevel, GrantableBot } from "@rakazo/contracts";
import { BotAvatar, OptionSelect } from "@rakazo/ui-web";

type Access = BotAccessLevel | "none";

/**
 * Which of the viewer's bots someone may use. One select per bot, so giving, changing and taking
 * back access are the same control.
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
  onChange: (botId: string, level: BotAccessLevel | null) => void;
}) {
  const { t } = useLingui();
  const options: { value: Access; label: string }[] = [
    { value: "none", label: t`No access` },
    { value: "chat", label: t`Can chat` },
    { value: "manage", label: t`Can manage` },
  ];
  return (
    <ul className="divide-y divide-border rounded-xl border border-border" data-testid="bot-access">
      {bots.map((bot) => (
        <li key={bot.id} className="flex items-center gap-3 px-3 py-2">
          <BotAvatar identity={bot.id} color={bot.color} avatarSet={bot.avatarSet} size={28} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body text-foreground">{bot.name}</span>
            {bot.spaceName ? (
              <span className="truncate text-body-sm text-muted-foreground">{bot.spaceName}</span>
            ) : null}
          </span>
          <OptionSelect<Access>
            aria-label={t`${personName}'s access to ${bot.name}`}
            size="sm"
            value={levelOf(bot.id) ?? "none"}
            disabled={disabled}
            onValueChange={(value) => onChange(bot.id, value === "none" ? null : value)}
            options={options}
          />
        </li>
      ))}
    </ul>
  );
}
