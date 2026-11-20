/**
 * What the person opened or closed of each run (its row, its tests, its output), kept apart from the views that show
 * it: a run's card and then its row show it the same, and a part drawn again finds it as it was. Until the person
 * chooses, each part takes the default its view gives.
 */
export function useRunnerDisclosures() {
  const chosen = useState<Record<string, boolean>>('runner-disclosures', () => ({}));

  return {
    /** Whether the part `id` is open: as the person left it, else `fallback`. */
    isOpen: (id: string, fallback: boolean): boolean => chosen.value[id] ?? fallback,
    /** Keeps the person's choice for the part `id`. */
    choose: (id: string, open: boolean): void => {
      chosen.value[id] = open;
    },
  };
}
