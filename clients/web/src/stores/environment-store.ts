import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

export interface EnvironmentConfig {
  emailRootDomain: string;
  isNonProduction: boolean;
}

interface EnvironmentActions {
  setEnvironment: (config: Partial<EnvironmentConfig>) => void;
}

type EnvironmentStore = EnvironmentConfig & EnvironmentActions;

function getDefaultEnvironment(): EnvironmentConfig {
  const env = import.meta.env.VITE_ENVIRONMENT;
  const isNonProduction = !env || env !== "production";

  let emailRootDomain: string;
  if (!env || env === "local") {
    emailRootDomain = "local.cadet.me";
  } else if (env === "dev") {
    emailRootDomain = "dev.cadet.me";
  } else if (env === "staging") {
    emailRootDomain = "staging.cadet.me";
  } else {
    emailRootDomain = "cadet.me";
  }

  return { emailRootDomain, isNonProduction };
}

const useEnvironmentStoreBase = create<EnvironmentStore>()((set) => ({
  ...getDefaultEnvironment(),
  setEnvironment: (config) => set(config),
}));

export const useEnvironmentStore = createSelectors(useEnvironmentStoreBase);
