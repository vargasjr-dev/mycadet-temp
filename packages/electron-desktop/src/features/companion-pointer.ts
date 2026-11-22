let onCompanion = false;

export const setPointerOnCompanion = (next: boolean): void => {
  onCompanion = next;
};

export const isPointerOnCompanion = (): boolean => onCompanion;
