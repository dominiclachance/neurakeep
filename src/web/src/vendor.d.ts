declare module "@react-sigma/core" {
  import type React from "react";
  import type Sigma from "sigma";
  export const SigmaContainer: React.FC<Record<string, unknown> & { children?: React.ReactNode }>;
  export const ControlsContainer: React.FC<{ position?: string; children?: React.ReactNode }>;
  export const ZoomControl: React.FC;
  export const FullScreenControl: React.FC;
  export function useSigma(): Sigma;
  export function useRegisterEvents(): (handlers: Record<string, (event: any) => void>) => void;
}

declare module "@react-sigma/layout-forceatlas2" {
  export function useWorkerLayoutForceAtlas2(options?: Record<string, unknown>): {
    start(): void;
    stop(): void;
    kill(): void;
    isRunning: boolean;
  };
}
