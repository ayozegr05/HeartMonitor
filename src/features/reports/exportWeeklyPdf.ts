import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

/**
 * Renders the weekly-report HTML to a PDF file and opens the system share
 * sheet. The file lands in the app cache — no account, no upload
 * (ADR-001 local-first): sharing it is the user's explicit action.
 */
export async function shareWeeklyPdf(html: string): Promise<void> {
  const { uri } = await Print.printToFileAsync({ html, base64: false });
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Compartir no está disponible en este dispositivo');
  }
  await Sharing.shareAsync(uri, {
    mimeType: 'application/pdf',
    dialogTitle: 'Informe semanal · HeartMonitor',
    UTI: 'com.adobe.pdf',
  });
}
