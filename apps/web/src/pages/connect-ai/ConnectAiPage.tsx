import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Field, FieldGroup, FieldLabel, OptionSelect, SwitchField } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageLoading } from "../../components/PageLoading";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";

/**
 * Where an outside AI's sign-in lands: the owner picks which bot's computer it may use, and the
 * browser returns to the AI with a one-time code.
 */
export function ConnectAiPage() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const queries = useSpaceQueries();
  const botFieldId = useId();
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const state = params.get("state") ?? undefined;
  const wellFormed =
    params.get("response_type") === "code" &&
    params.get("code_challenge_method") === "S256" &&
    Boolean(clientId && redirectUri && codeChallenge);
  const request = useQuery({
    ...queries.computer.accessKeys.request.queryOptions({ input: { clientId, redirectUri } }),
    enabled: wellFormed,
    retry: false,
  });
  const [botId, setBotId] = useState<string | null>(null);
  const [allowCommands, setAllowCommands] = useState(false);
  const approve = useSave({
    save: (input: { botId: string; allowCommands: boolean }, rpc) =>
      rpc.computer.accessKeys.approve({
        clientId,
        redirectUri,
        codeChallenge,
        state,
        ...input,
      }),
    onSaved: (saved) => window.location.assign(saved.redirectTo),
    closesScreen: true,
  });

  if (wellFormed && request.isPending) return <PageLoading />;
  const info = request.data;
  if (!wellFormed || !info) {
    return (
      <Centered>
        <div className="text-heading3 text-foreground">
          <Trans>This sign-in link is not valid</Trans>
        </div>
        <Button type="button" className="mt-5" onClick={() => window.location.assign("/app")}>
          <Trans>Return to Rakazo</Trans>
        </Button>
      </Centered>
    );
  }
  const chosen = botId ?? info.bots[0]?.id ?? null;
  const decline = () => {
    const back = new URL(redirectUri);
    back.searchParams.set("error", "access_denied");
    if (state !== undefined) back.searchParams.set("state", state);
    window.location.assign(back.toString());
  };
  return (
    <Centered>
      <form
        className="w-full max-w-sm space-y-5 text-left"
        onSubmit={(event) => {
          event.preventDefault();
          if (chosen && !approve.pending) approve.run({ botId: chosen, allowCommands });
        }}
      >
        <div className="space-y-1">
          <h1 className="text-heading3 text-foreground">
            <Trans>Let {info.clientName} use a bot's computer?</Trans>
          </h1>
          <p className="text-body-sm text-muted-foreground">
            <Trans>It can see and use the screen as you, and returns to {info.redirectHost}.</Trans>
          </p>
        </div>
        {info.bots.length ? (
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor={botFieldId}>
                <Trans>Bot</Trans>
              </FieldLabel>
              <OptionSelect
                id={botFieldId}
                value={chosen ?? ""}
                onValueChange={setBotId}
                options={info.bots.map((bot) => ({ value: bot.id, label: bot.name }))}
              />
            </Field>
            <SwitchField
              label={<Trans>Allow terminal commands</Trans>}
              checked={allowCommands}
              onCheckedChange={setAllowCommands}
            />
          </FieldGroup>
        ) : (
          <p className="text-body text-muted-foreground">
            <Trans>None of your bots has a computer yet.</Trans>
          </p>
        )}
        {approve.error ? (
          <p role="alert" className="text-body-sm text-destructive">
            {errorText(approve.error, t`Could not connect`)}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={decline}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            type="submit"
            disabled={!chosen || approve.pending}
            data-testid="connect-ai-allow"
          >
            <Trans>Allow</Trans>
          </Button>
        </div>
      </form>
    </Centered>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6 text-center">
      <div className="flex w-full flex-col items-center">{children}</div>
    </div>
  );
}
