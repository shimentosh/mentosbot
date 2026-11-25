import { MenuView } from "@expo/ui/community/menu";
import { useLingui } from "@lingui/react/macro";
import type { AccountSecurity, SignInProvider } from "@rakazo/contracts";
import { isIdentityConfirmationRequired } from "@rakazo/contracts";
import { accountDisplay, displayName } from "@rakazo/core";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, ScrollView, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAccountDeletion } from "../../components/account-deletion";
import { useIdentityConfirmation } from "../../components/confirm-identity";
import { NameDialog, TextFieldDialog } from "../../components/name-dialog";
import { SettingsGroup, SettingsRow, useStackedSettings } from "../../components/settings-group";
import { createAccountNameEditor } from "../../lib/account-name-editor";
import { rpc } from "../../lib/api";
import {
  changeAccountEmail,
  fetchAccountSecurity,
  passwordResetCapabilities,
  updateAccountName,
} from "../../lib/api-auth";
import { mobileTokens } from "../../lib/appearance";
import { dateLocaleForUi, useUiLocale } from "../../lib/i18n";
import type { MobileMe } from "../../lib/mobile-types";
import { useResolvedAppearance, useThemedStyles } from "../../lib/native";
import type { MobilePasskey } from "../../lib/passkey";
import {
  addPasskey,
  deletePasskey,
  listPasskeys,
  passkeysAvailable,
  renamePasskey,
} from "../../lib/passkey";
import { promptSectionName } from "../../lib/section-name-prompt";
import { createSettingsPageStyles } from "../../lib/settings-page-styles";
import { useSideInsets } from "../../lib/side-insets";
import { continueWithSso } from "../../lib/sso";
import {
  loadTrustedLinkSites,
  removeTrustedLinkSite,
  useTrustedLinkSites,
} from "../../lib/trusted-link-sites";
import { errorText } from "../../lib/user-error";

/** Who the person is and how they sign in: name, password, passkeys, trusted sites, deletion. */
export default function Profile() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const locale = useUiLocale();
  const router = useRouter();
  const styles = useThemedStyles(createSettingsPageStyles);
  const stacked = useStackedSettings();
  const colorScheme = useResolvedAppearance();
  const [providers, setProviders] = useState<SignInProvider[]>([]);

  const [me, setMe] = useState<MobileMe | null>(null);
  const account = accountDisplay(me ?? {}, t`Your account`);
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [namePending, setNamePending] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const currentName = account.label === me?.email ? "" : displayName(me?.name, "");

  const nameSaving = useRef(false);
  const nameSaveVersion = useRef(0);
  const { saveName, editName, closeNameDialog } = createAccountNameEditor({
    currentName,
    pending: nameSaving,
    saveVersion: nameSaveVersion,
    Platform,
    Alert,
    errorText,
    updateAccountName,
    refresh: () => rpc("me"),
    onSaved: (name) => setMe((current) => (current ? { ...current, name } : current)),
    onRefreshed: setMe,
    setNameDraft,
    setNamePending,
    setNameError,
    setNameDialogOpen,
  });

  const [security, setSecurity] = useState<AccountSecurity | null>(null);
  const unlinkedProviders = security?.linkedProviderIds
    ? providers.filter((provider) => !security.linkedProviderIds?.includes(provider.id))
    : [];
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [emailDraft, setEmailDraft] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailPending, setEmailPending] = useState(false);
  /** The address a change link went to; the account keeps its email until it is opened. */
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null);

  function promptEmail(value: string, message?: string) {
    Alert.prompt(
      t`Change email`,
      message,
      [
        { text: t`Cancel`, style: "cancel" },
        {
          text: t`Save`,
          isPreferred: true,
          onPress: (draft?: string) => void saveEmail(draft ?? ""),
        },
      ],
      "plain-text",
      value,
      "email-address",
    );
  }

  function editEmail() {
    if (emailPending || !me?.email) return;
    if (Platform.OS === "ios") promptEmail(me.email);
    else {
      setEmailDraft(me.email);
      setEmailError(null);
      setEmailDialogOpen(true);
    }
  }

  async function saveEmail(value: string) {
    if (emailPending) return;
    const next = value.trim().toLowerCase();
    if (!next || next === me?.email?.toLowerCase()) {
      setEmailDialogOpen(false);
      return;
    }
    setEmailPending(true);
    setEmailError(null);
    let failure: string | undefined;
    try {
      await withIdentityConfirmation(() => changeAccountEmail(next));
      setEmailSentTo(next);
      setEmailDialogOpen(false);
    } catch (error) {
      // A dismissed confirmation leaves things as they were.
      if (!isIdentityConfirmationRequired(error))
        failure = errorText(error, t`Could not update email`);
    } finally {
      setEmailPending(false);
    }
    if (!failure) return;
    if (Platform.OS === "ios") promptEmail(value, failure);
    else setEmailError(failure);
  }
  const canChangePassword = security?.hasPassword && security.passwordChangeEnabled !== false;
  const deletion = useAccountDeletion({ onSecurity: setSecurity });
  const { run: securityAction, pending } = deletion;
  const [passkeys, setPasskeys] = useState<MobilePasskey[] | null>(null);
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyLoadError, setPasskeyLoadError] = useState<string | null>(null);
  // A failed load keeps the section, with Add and a retry, instead of hiding it.
  const loadPasskeys = useCallback(async () => {
    setPasskeyLoadError(null);
    try {
      setPasskeys(await listPasskeys());
    } catch (err) {
      setPasskeys((current) => current ?? []);
      setPasskeyLoadError(errorText(err, t`Could not continue`));
    }
  }, [t]);
  const trustedSites = useTrustedLinkSites();

  // Read on every visit, so a failed read retries when the page is shown again.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void rpc("me")
        .then((next) => {
          if (active) setMe(next);
        })
        .catch(() => undefined);
      return () => {
        active = false;
      };
    }, []),
  );

  useEffect(() => {
    void fetchAccountSecurity()
      .then(setSecurity)
      .catch(() => undefined);
    void passwordResetCapabilities()
      .then(async (capabilities) => {
        setProviders((capabilities.providers ?? []).filter((provider) => provider.id !== "oidc"));
        if (await passkeysAvailable(capabilities)) await loadPasskeys();
      })
      .catch(() => undefined);
  }, [loadPasskeys]);

  useFocusEffect(
    useCallback(() => {
      void loadTrustedLinkSites().catch(() => undefined);
    }, []),
  );

  async function passkeyAction(run: () => Promise<unknown>) {
    setPasskeyPending(true);
    setPasskeyError(null);
    try {
      await run();
      await loadPasskeys();
    } catch (err) {
      setPasskeyError(errorText(err, t`Could not continue`));
    } finally {
      setPasskeyPending(false);
    }
  }

  function passkeyMenuAction(passkey: MobilePasskey, name: string, action: string) {
    if (action === "rename") {
      promptSectionName({
        title: t`Rename`,
        cancelLabel: t`Cancel`,
        submitLabel: t`Save`,
        defaultValue: passkey.name ?? undefined,
        onSubmit: (next) => void passkeyAction(() => renamePasskey(passkey.id, next)),
      });
    } else if (action === "delete") {
      Alert.alert(t`Delete ${name}?`, undefined, [
        { text: t`Cancel`, style: "cancel" },
        {
          text: t`Delete`,
          style: "destructive",
          onPress: () => void passkeyAction(() => deletePasskey(passkey.id)),
        },
      ]);
    }
  }

  function removeTrustedSite(site: string) {
    void removeTrustedLinkSite(site).catch((cause: unknown) =>
      Alert.alert(t`Could not continue`, errorText(cause, t`Try again.`)),
    );
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, stacked && styles.compactContent]}
        contentInsetAdjustmentBehavior="automatic"
      >
        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            accessibilityLabel={t`Edit name`}
            accessibilityValue={{
              text:
                me?.email && account.label !== me.email
                  ? `${account.label}, ${me.email}`
                  : account.label,
            }}
            chevron="right"
            disabled={!me}
            detail={me?.email && account.label !== me.email ? me.email : undefined}
            prominent
            title={account.label}
            dimmed={namePending}
            onPress={editName}
          />
          {security?.emailChange && me?.email ? (
            <SettingsRow
              accessibilityRole="button"
              chevron="right"
              detail={emailSentTo ? t`Open the link sent to ${emailSentTo}` : undefined}
              dimmed={emailPending}
              disabled={emailPending}
              title={t`Change email`}
              onPress={editEmail}
            />
          ) : null}
        </SettingsGroup>

        {(security?.sso && !security.ssoLinked) ||
        unlinkedProviders.length > 0 ||
        canChangePassword ? (
          <SettingsGroup>
            {security?.sso && !security.ssoLinked ? (
              <SettingsRow
                accessibilityRole="button"
                chevron="right"
                disabled={pending}
                dimmed={pending}
                title={t`Link ${security.sso.name === "SSO" ? t`SSO` : security.sso.name}`}
                onPress={() =>
                  void securityAction(async () => {
                    if (await continueWithSso("link")) setSecurity(await fetchAccountSecurity());
                  })
                }
              />
            ) : null}
            {unlinkedProviders.map((provider) => (
              <SettingsRow
                key={provider.id}
                accessibilityRole="button"
                chevron="right"
                disabled={pending}
                title={t`Link ${provider.name}`}
                onPress={() =>
                  void securityAction(async () => {
                    if (await continueWithSso("link", provider.id))
                      setSecurity(await fetchAccountSecurity());
                  })
                }
              />
            ))}
            {canChangePassword ? (
              <SettingsRow
                accessibilityRole="button"
                chevron="right"
                onPress={() => router.push("/change-password")}
                title={t`Change password`}
              />
            ) : null}
          </SettingsGroup>
        ) : null}

        {passkeys ? (
          <SettingsGroup accessibilityLabel={t`Passkeys`} label={t`Passkeys`}>
            {passkeys.map((passkey) => {
              const name = passkey.name ?? t`Passkey`;
              const created = passkey.createdAt ? new Date(passkey.createdAt) : null;
              return (
                <MenuView
                  key={passkey.id}
                  actions={[
                    // Alert.prompt, which renames, exists only on iOS.
                    ...(Platform.OS === "ios" ? [{ id: "rename", title: t`Rename` }] : []),
                    { id: "delete", title: t`Delete`, attributes: { destructive: true } },
                  ]}
                  colorScheme={colorScheme}
                  onPressAction={(event) =>
                    passkeyMenuAction(passkey, name, event.nativeEvent.event)
                  }
                  title={name}
                >
                  <SettingsRow
                    accessible
                    accessibilityRole="button"
                    detail={
                      created && !Number.isNaN(created.getTime())
                        ? created.toLocaleDateString(dateLocaleForUi(locale), {
                            dateStyle: "medium",
                          })
                        : undefined
                    }
                    dimmed={passkeyPending}
                    title={name}
                  />
                </MenuView>
              );
            })}
            <SettingsRow
              accessibilityRole="button"
              disabled={passkeyPending}
              dimmed={passkeyPending}
              onPress={() => void passkeyAction(addPasskey)}
              title={t`Add passkey`}
            />
            {passkeyLoadError ? (
              <>
                <Text accessibilityRole="alert" style={styles.error}>
                  {passkeyLoadError}
                </Text>
                <SettingsRow
                  accessibilityRole="button"
                  onPress={() => void loadPasskeys()}
                  title={t`Retry`}
                />
              </>
            ) : null}
            {passkeyError ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {passkeyError}
              </Text>
            ) : null}
          </SettingsGroup>
        ) : null}

        {trustedSites.length > 0 ? (
          <SettingsGroup accessibilityLabel={t`Trusted sites`} label={t`Trusted sites`}>
            {trustedSites.map((site) => (
              <MenuView
                key={site}
                actions={[{ id: "remove", title: t`Remove`, attributes: { destructive: true } }]}
                colorScheme={colorScheme}
                onPressAction={() => removeTrustedSite(site)}
                title={site}
              >
                <SettingsRow accessible accessibilityRole="button" title={site} />
              </MenuView>
            ))}
          </SettingsGroup>
        ) : null}

        <SettingsGroup>
          <SettingsRow
            accessibilityRole="button"
            destructive
            dimmed={pending}
            disabled={pending}
            onPress={() => void deletion.request()}
            title={t`Delete account`}
            trailing={
              pending ? <ActivityIndicator color={mobileTokens().destructive} /> : undefined
            }
          />
          {deletion.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {deletion.error}
            </Text>
          ) : null}
        </SettingsGroup>
      </ScrollView>
      {nameDialogOpen ? (
        <NameDialog
          draft={nameDraft}
          error={nameError}
          saving={namePending}
          onChange={(value) => {
            setNameDraft(value);
            setNameError(null);
          }}
          onSave={(value) => void saveName(value)}
          onClose={closeNameDialog}
        />
      ) : null}
      {emailDialogOpen ? (
        <TextFieldDialog
          title={t`Change email`}
          label={t`Email`}
          submitLabel={t`Save`}
          value={emailDraft}
          error={emailError}
          saving={emailPending}
          input={{
            autoComplete: "email",
            autoCapitalize: "none",
            autoCorrect: false,
            keyboardType: "email-address",
          }}
          onChange={(value) => {
            setEmailDraft(value);
            setEmailError(null);
          }}
          onSubmit={(value) => void saveEmail(value)}
          onClose={() => {
            if (!emailPending) setEmailDialogOpen(false);
          }}
        />
      ) : null}
      {identityDialog}
      {deletion.dialog}
    </SafeAreaView>
  );
}
