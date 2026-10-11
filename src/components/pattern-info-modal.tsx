import { useRouter, type Href } from 'expo-router';
import { Modal, Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import type { PatternInfo } from '@/domain/patternInfo';
import { useTheme } from '@/hooks/use-theme';

/**
 * Contextual "what did the app see?" popup — one pattern at a time,
 * with a door into the full Guía catalogue.
 */
export function PatternInfoModal({
  pattern,
  onClose,
}: {
  pattern: PatternInfo | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  const router = useRouter();
  if (!pattern) return null;
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <ThemedView
          type="backgroundElement"
          style={styles.card}
          onStartShouldSetResponder={() => true}>
          <ThemedText type="smallBold">{pattern.title}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {pattern.what}
          </ThemedText>
          <ThemedText type="small">{pattern.explain}</ThemedText>
          <ThemedText type="small" style={{ color: '#FFB020' }}>
            {pattern.note}
          </ThemedText>
          <Pressable
            onPress={() => {
              onClose();
              router.push('/learn' as Href);
            }}
            style={[
              styles.linkButton,
              { backgroundColor: theme.backgroundSelected },
            ]}>
            <ThemedText type="smallBold">Ver todos los patrones →</ThemedText>
          </Pressable>
        </ThemedView>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.four,
    gap: Spacing.two,
  },
  linkButton: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    alignItems: 'center',
    marginTop: Spacing.one,
  },
});
