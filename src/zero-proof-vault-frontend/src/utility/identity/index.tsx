// (Refactored for ghostkeys MVP)

import {
  createContext,
  useState,
  useEffect,
  useCallback,
  useContext,
  ReactNode,
  useRef,
} from "react";
import {
  LOCAL_STORAGE_EVM_PUBLIC_ADDRESS,
  LOCAL_STORAGE_ICP_PUBLIC_ADDRESS,
  LOCAL_STORAGE_ORGANIZATION_VAULT_ID,
  LOCAL_STORAGE_SEED_PHRASE,
  shortenAddress,
} from "./constants";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { Principal } from "@dfinity/principal";
import { mnemonicToAccount } from "viem/accounts";
import { mnemonicToSeedSync } from "@scure/bip39";
import { generate } from "random-words";
import LoadingAnimation from "../../components/NotFound/LoadingAnimation";

// Interfaces for Vault and User Profile
export type Vault = {
  vaultID: string;
  nickname: string;
  icpPublicAddress: string;
  endpoint: string;
};

export type UserProfile = {
  userID: string;
  icpPublicAddress: string;
  evmPublicAddress: string;
  seedPhrase: string;
};

export type AuthProfile = {
  icpPublicKey: string;
  evmPublicKey: string;
  userID: string;
  slug: string;
  icpAccount: {
    identity: Ed25519KeyIdentity;
    principal: Principal;
  } | null;
};

export type IdentityContextType = {
  currentVault: Vault | null;
  currentProfile: AuthProfile | null;
  createVault: (nickname: string) => Promise<Vault>;
  switchVault: (vault: Vault) => void;
  renameVault: (vaultID: string, newName: string) => Vault | undefined;
  listVaults: () => Promise<Vault[]>;
  createProfileFromSeed: (seed: string) => Promise<UserProfile>;
  switchProfile: (profile: UserProfile) => Promise<void>;
};

const IdentityContext = createContext<IdentityContextType | undefined>(undefined);
const DB_NAME = "Ghostkeys-identity";
const DB_VERSION = 1;
const VAULTS_STORE = "vaults";
const PROFILES_STORE = "profiles";

const deriveEd25519KeyFromSeed = async (seed: Uint8Array): Promise<Uint8Array> => {
  const hash = await crypto.subtle.digest("SHA-256", seed);
  return new Uint8Array(hash).slice(0, 32);
};

export function IdentitySystemProvider({ children }: { children: ReactNode }) {
  const db = useRef<IDBDatabase | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [currentVault, setCurrentVault] = useState<Vault | null>(null);
  const [currentProfile, setCurrentProfile] = useState<AuthProfile | null>(null);

  useEffect(() => {
    const init = async () => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(VAULTS_STORE)) {
          db.createObjectStore(VAULTS_STORE, { keyPath: "vaultID" });
        }
        if (!db.objectStoreNames.contains(PROFILES_STORE)) {
          db.createObjectStore(PROFILES_STORE, { keyPath: "userID" });
        }
      };

      request.onsuccess = async (e) => {
        db.current = (e.target as IDBOpenDBRequest).result;
        await bootstrap();
        setIsReady(true);
      };
    };

    init();
  }, []);

  const bootstrap = async () => {
    const seed = localStorage.getItem(LOCAL_STORAGE_SEED_PHRASE);
    if (seed) {
      const profile = await createProfileFromSeed(seed);
      await switchProfile(profile);
    } else {
      const generated = (generate(12) as string[]).join(" ");
      const profile = await createProfileFromSeed(generated);
      await saveProfile(profile);
      await switchProfile(profile);
      overwriteLocalStorage(profile);
    }
  };

  const overwriteLocalStorage = (profile: UserProfile) => {
    localStorage.setItem(LOCAL_STORAGE_SEED_PHRASE, profile.seedPhrase);
    localStorage.setItem(LOCAL_STORAGE_EVM_PUBLIC_ADDRESS, profile.evmPublicAddress);
    localStorage.setItem(LOCAL_STORAGE_ICP_PUBLIC_ADDRESS, profile.icpPublicAddress);
  };

  const createProfileFromSeed = useCallback(async (seed: string): Promise<UserProfile> => {
    const evm = mnemonicToAccount(seed);
    const derivedKey = await deriveEd25519KeyFromSeed(mnemonicToSeedSync(seed));
    const identity = Ed25519KeyIdentity.fromSecretKey(derivedKey);
    const principal = identity.getPrincipal().toString();

    return {
      userID: `UserID_${principal}`,
      icpPublicAddress: principal,
      evmPublicAddress: evm.address,
      seedPhrase: seed,
    };
  }, []);

  const saveProfile = async (profile: UserProfile) => {
    if (!db.current) throw new Error("DB not initialized");
    const tx = db.current.transaction(PROFILES_STORE, "readwrite");
    tx.objectStore(PROFILES_STORE).put(profile);
  };

  const switchProfile = async (profile: UserProfile) => {
    const derivedKey = await deriveEd25519KeyFromSeed(mnemonicToSeedSync(profile.seedPhrase));
    const identity = Ed25519KeyIdentity.fromSecretKey(derivedKey);
    //const publicKeyRaw = identity.getPublicKey().toRaw(); // returns Uint8Array
    const principal = identity.getPrincipal();

    setCurrentProfile({
      icpPublicKey: profile.icpPublicAddress,
      evmPublicKey: profile.evmPublicAddress,
      userID: profile.userID,
      slug: shortenAddress(profile.icpPublicAddress),
      icpAccount: {
        identity,
        principal,
      },
    });
  };

  const createVault = async (nickname: string): Promise<Vault> => {
    if (!currentProfile) throw new Error("No profile set");
    const vaultID = `Vault_${currentProfile.userID}_${Date.now()}`;
    const newVault: Vault = {
      vaultID,
      nickname,
      icpPublicAddress: currentProfile.icpPublicKey,
      endpoint: "",
    };
    if (!db.current) throw new Error("DB not initialized");
    const tx = db.current.transaction(VAULTS_STORE, "readwrite");
    tx.objectStore(VAULTS_STORE).put(newVault);
    return newVault;
  };

  const renameVault = (vaultID: string, newName: string) => {
    if (!db.current) throw new Error("DB not initialized");
    if (!currentProfile) throw new Error("No profile set");
    const tx = db.current.transaction(VAULTS_STORE, "readwrite");
    const store = tx.objectStore(VAULTS_STORE);
    const vault = store.get(vaultID) as unknown as Vault | undefined;
    if (vault) {
      vault.nickname = newName;
      store.put(vault);
    }
    return vault;
  }

  const switchVault = (vault: Vault) => {
    setCurrentVault(vault);
    localStorage.setItem(LOCAL_STORAGE_ORGANIZATION_VAULT_ID, vault.vaultID);
  };

  const listVaults = async (): Promise<Vault[]> => {
    if (!db.current) throw new Error("DB not initialized");
    const tx = db.current.transaction(VAULTS_STORE, "readonly");
    const req = tx.objectStore(VAULTS_STORE).getAll();
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as Vault[]);
      req.onerror = () => reject("Failed to list vaults");
    });
  };

  const contextValue: IdentityContextType = {
    currentVault,
    currentProfile,
    createVault,
    switchVault,
    renameVault,
    listVaults,
    createProfileFromSeed,
    switchProfile,
  };

  if (!isReady) return <LoadingAnimation />;
  return <IdentityContext.Provider value={contextValue}>{children}</IdentityContext.Provider>;
}

export function useIdentitySystem() {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error("useIdentitySystem must be inside provider");
  return ctx;
}
