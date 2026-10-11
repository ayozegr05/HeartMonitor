/**
 * Plain-Spanish catalogue of everything the app can flag — the content
 * behind the ⓘ buttons and the Guía tab. Wording stays observational:
 * "pattern compatible with X", never a diagnosis.
 */

export interface PatternInfo {
  id: string;
  /** Short display name. */
  title: string;
  /** What the app literally saw on the trace. */
  what: string;
  /** What it means in plain words. */
  explain: string;
  /** How to read its importance. */
  note: string;
}

export const PATTERN_CATALOG: PatternInfo[] = [
  {
    id: 'bradycardia',
    title: 'Bradicardia',
    what: 'La FC baja del umbral (día/noche) durante varios segundos seguidos.',
    explain:
      'El corazón latiendo despacio. Dormido es normal llegar a 40–50 bpm ' +
      '(tono vagal alto); de día o con mareo ya es más llamativo.',
    note: 'Frecuente y benigno de noche. Si hay síntomas o caídas muy bajas, coméntalo al cardiólogo.',
  },
  {
    id: 'sinus',
    title: 'Pausa sinusal',
    what: 'Un hueco largo en el ritmo sin onda P dentro — el nodo sinusal "se saltó" un latido.',
    explain:
      'El marcapasos natural del corazón deja de emitir un momento. ' +
      'Muy común dormido por el tono vagal; preocupa más si es larga o de día.',
    note: 'Habitual en sueño. Si son >3 s o vienen con síntomas, enseña la tira.',
  },
  {
    id: 'blocked',
    title: 'Pausa compensatoria (latido bloqueado)',
    what: 'Una onda P sola dentro del hueco — la aurícula latió pero el impulso no llegó al ventrículo.',
    explain:
      'El "relevo" aurícula→ventrículo se cortó en ese latido (bloqueo AV). ' +
      'El siguiente latido llega con retraso, de ahí la pausa.',
    note: 'Depende del patrón: con PR cada vez más largo suele ser benigno; con PR fijo merece revisión.',
  },
  {
    id: 'extrasystole',
    title: 'Extrasístole',
    what: 'Un latido prematuro y ancho colado en el ritmo, seguido de su pausa compensatoria.',
    explain:
      'El ventrículo dispara un latido extra antes de tiempo — casi todos los ' +
      'corazones los tienen a veces. La pausa siguiente es el "reseteo".',
    note: 'Ocasional = normal. Si son muy seguidas o en rachas, enseña las tiras.',
  },
  {
    id: 'av1',
    title: 'PR prolongado (bloqueo AV 1er grado)',
    what: 'El intervalo PR medio supera 200 ms — el impulso tarda más de lo normal en bajar.',
    explain:
      'No es un bloqueo real: TODOS los latidos conducen, solo que con ' +
      'retraso. Se considera un hallazgo, no una urgencia.',
    note: 'Suele ser benigno. Se vigila; solo preocupa si progresa a bloqueos de grado mayor.',
  },
  {
    id: 'wenckebach',
    title: 'Mobitz I (Wenckebach)',
    what: 'El PR se va alargando latido a latido hasta que uno se bloquea — y el ciclo se repite.',
    explain:
      'El nodo AV "se fatiga": cada conducción tarda más hasta que una no pasa. ' +
      'Bloqueo AV de 2º grado tipo I.',
    note: 'Habitualmente benigno — frecuente de noche y en gente con tono vagal alto. Se vigila.',
  },
  {
    id: 'mobitz2',
    title: 'Mobitz II',
    what: 'Latidos bloqueados con el PR constante — cae un latido sin avisar.',
    explain:
      'El bloqueo está más abajo (HIS-Purkinje): conduce… conduce… y de repente ' +
      'no. Bloqueo AV de 2º grado tipo II.',
    note: 'El serio de los dos tipos: puede progresar a bloqueo completo. Enseña la tira al cardiólogo.',
  },
  {
    id: 'wide-qrs',
    title: 'QRS ancho',
    what: 'La media del complejo QRS supera 120 ms — el ventrículo tarda más en activarse.',
    explain:
      'Puede ser un bloqueo de rama (el impulso baja por el lado sano) o un ' +
      'origen ventricular. Con una sola derivación (la H10) se ve la anchura ' +
      'pero no el tipo.',
    note: 'Si sale de forma consistente, es de los flags que más valen una tira al cardiólogo.',
  },
  {
    id: 'missing-p',
    title: 'Ondas P ausentes',
    what: 'Más del 70 % de los latidos sin onda P detectable.',
    explain:
      'Sin P la aurícula no lidera el ritmo — ocurre en fibrilación auricular ' +
      'y en ritmos juntionales, pero también cuando la señal llega sucia ' +
      '(movimiento, banda mal puesta).',
    note: 'Antes de preocuparse: repite la tira quieto. Si persiste, enseña la tira.',
  },
  {
    id: 'irregular',
    title: 'Ritmo irregular',
    what: 'Los intervalos RR varían mucho sin que haya latidos bloqueados.',
    explain:
      'El corazón no lleva un compás regular — la sospecha habitual es ' +
      'fibrilación auricular, aunque señal ruidosa también irregulariza.',
    note: 'Si además faltan las ondas P, la app lo marca como posible FA.',
  },
  {
    id: 'af',
    title: 'Posible fibrilación auricular',
    what: 'Ritmo irregular + ausencia de ondas P en la misma tira.',
    explain:
      'La combinación clásica de la FA: la aurícula tiembla en vez de latir ' +
      'ordenado, así que no hay P y los latidos llegan a destiempo.',
    note: 'La FA es la arritmia que más riesgo de ictus sube — si este flag repite, enséñalo al cardiólogo. Una tira con ruido puede imitarla: confirma quieto.',
  },
];

/**
 * Maps a generated flag/label string to its catalogue entry.
 * Order matters — check the most specific phrases first.
 */
export function patternForFlag(flag: string): PatternInfo | null {
  const f = flag.toLowerCase();
  const match = (id: string) =>
    PATTERN_CATALOG.find((p) => p.id === id) ?? null;
  if (f.includes('wenckebach') || f.includes('mobitz i ')) return match('wenckebach');
  if (f.includes('mobitz ii')) return match('mobitz2');
  if (f.includes('fibrilaci')) return match('af');
  if (f.includes('1er grado') || f.includes('pr prolongado')) return match('av1');
  if (f.includes('extrasistol')) return match('extrasystole');
  if (f.includes('compensatoria') || f.includes('latido bloqueado'))
    return match('blocked');
  if (f.includes('sinusal')) return match('sinus');
  if (f.includes('qrs ancho')) return match('wide-qrs');
  if (f.includes('onda p')) return match('missing-p');
  if (f.includes('irregular')) return match('irregular');
  if (f.includes('bradicardia')) return match('bradycardia');
  return null;
}

/** For the history event types ('pause' covers the three pause kinds). */
export function patternForEventType(type: string): PatternInfo | null {
  if (type === 'bradycardia') {
    return PATTERN_CATALOG.find((p) => p.id === 'bradycardia') ?? null;
  }
  if (type === 'pause') {
    // Generic entry for "a pause happened" — the strip detail refines it.
    return {
      id: 'pause',
      title: 'Pausa',
      what: 'Un intervalo RR mucho más largo que el ritmo de esa noche.',
      explain:
        'Las pausas tienen causas distintas: sinusal (sin onda P, normal ' +
        'dormido), latido bloqueado (P sin respuesta) o tras una ' +
        'extrasístole. La tira ECG de esa noche dice cuál fue.',
      note: 'Abre la tira de esa sesión para ver la clasificación concreta.',
    };
  }
  return null;
}
