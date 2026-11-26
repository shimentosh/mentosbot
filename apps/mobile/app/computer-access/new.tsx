import { useLingui } from "@lingui/react/macro";
import type { ComputerAccessKeyCreated } from "@rakazo/contracts";
import { COMPUTER_ACCESS_KEY_NAME_MAX_LENGTH } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging/best-effort";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { NativeSymbol } from "../../components/native/native-symbol";
import {
  SettingsGroup,
  SettingsInputRow,
  SettingsRow,
  SettingsSwitch,
} from "../../components/settings/settings-group";
import { errorText } from "../../lib/api/user-error";
import { mobileTokens } from "../../lib/appearance/appearance";
import { native, useThemedStyles } from "../../lib/native/native";
import { useScreenHeader } from "../../lib/navigation/screen-header";
import { rpcQuery, useSave } from "../../lib/query/query";

/** Creates a key for an outside AI and shows it once, ready to copy into that AI's MCP servers. */
export default function NewComputerAccessKey() {
  const { botId = "" } = useLocalSearchParams<{ botId?: string }>();
  const { t } = useLingui();
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const [name, setName] = useState("");
  const [allowCommands, setAllowCommands] = useState(false);
  const [created, setCreated] = useState<ComputerAccessKeyCreated | null>(null);
  const [copied, setCopied] = useState<"url" | "header" | null>(null);
  const create = useSave({
    save: (input: { name: string; allowCommands: boolean }, send) =>
      send("computer/accessKeys/create", { botId, ...input }),
    stale: [rpcQuery("computer/accessKeys/list", { botId }).queryKey],
    onSaved: (saved) => setCreated(saved),
  });
  const trimmed = name.trim();
  const submit = () => {
    if (botId && trimmed) create.run({ name: trimmed, allowCommands });
  };
  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: "/computer-access", params: { botId } });
  };

  useScreenHeader({
    action: created
      ? { label: t`Done`, onPress: close }
      : { label: t`Create key`, disabled: !trimmed, busy: create.pending, onPress: submit },
  });

  if (created) {
    const rows = [
      { id: "url" as const, label: t`URL`, value: created.url },
      { id: "header" as const, label: t`Header`, value: `Authorization: Bearer ${created.token}` },
    ];
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <SettingsGroup footer={t`Add these to your AI's MCP servers. The key is shown only once.`}>
          {rows.map(({ id, label, value }) => (
            <SettingsRow
              key={id}
              accessibilityRole="button"
              accessibilityLabel={copied === id ? t`Copied` : t`Copy ${label}`}
              title={label}
              detail={value}
              trailing={
                <NativeSymbol
                  ios={copied === id ? "checkmark" : "doc.on.doc"}
                  android={copied === id ? "checkmark" : "copy-outline"}
                  size={18}
                  color={native.tertiaryLabel}
                />
              }
              onPress={() =>
                void bestEffort(
                  "copy computer access key",
                  Clipboard.setStringAsync(value).then((ok) => {
                    if (ok !== false) setCopied(id);
                  }),
                )
              }
            />
          ))}
        </SettingsGroup>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <SettingsGroup>
        <SettingsInputRow
          autoFocus
          accessibilityLabel={t`Name`}
          placeholder={t`Desktop assistant`}
          maxLength={COMPUTER_ACCESS_KEY_NAME_MAX_LENGTH}
          editable={!create.pending}
          returnKeyType="done"
          value={name}
          onChangeText={setName}
          onSubmitEditing={submit}
        />
        <SettingsSwitch
          label={t`Allow terminal commands`}
          value={allowCommands}
          disabled={create.pending}
          onChange={setAllowCommands}
        />
      </SettingsGroup>
      {create.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {errorText(create.error, t`Could not create key`)}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    content: { padding: 20, gap: 24, paddingBottom: 40 },
    error: { color: tokens.destructive, fontSize: 14 },
  });
}
