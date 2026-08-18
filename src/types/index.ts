import type { SimulationStep, SimulationPhase, SimulationCardRef } from '../data/tutorialSimulationData';

// Card types
export interface Card {
  id: string;
  name: string;
  set: string;
  setCode: string;
  rarity?: string;
  cardNumber: string;
  imageUrl?: string;
  price?: TCGPriceInfo;
  priceHistory?: Record<string, number>;
  description?: string;
  artist?: string;
  category: CardCategory;
}

export interface TCGPriceInfo {
  marketPrice?: number;
  sellPrice?: number;
  buyPrice?: number;
  trend?: 'up' | 'down' | 'stable';
  lastUpdated: string;
  source: string;
}

export type CardCategory = 'pokemon' | 'magic' | 'yugioh' | 'sports' | 'other';

// Search types
export interface TCGSearchResult {
  cards: Card[];
  totalFound: number;
  query: string;
  sources: string[];
}

// Scanner types
export interface ScanResult {
  cardNumber: string;
  setCode?: string;
  confidence: number;
}

// Navigation types
export type RootStackParamList = {
  MainDrawer: undefined;
  CardDetail: { card: Card };
  Scanner: undefined;
  SearchResults: { query: string; results: TCGSearchResult };
  TutorialDetail: { sectionId: string };
  TutorialSimulation: undefined;
};

export type AuthStackParamList = {
  Login: undefined;
  Main: undefined;
};

export type MainDrawerParamList = {
  Home: undefined;
  Scan: undefined;
  Search: undefined;
  Favorites: undefined;
  DeckEditor: undefined;
  TournamentReport: undefined;
  Watchlist: undefined;
  Settings: undefined;
  Tutorial: undefined;
};

// Settings types
export type SimPhase = 'setup' | 'reset' | 'draw' | 'cheer' | 'main' | 'performance' | 'end';

export type { SimulationStep, SimulationPhase, SimulationCardRef };

// Settings types
export interface AppSettings {
  defaultCategory: CardCategory;
  preferredCurrency: string;
  notifications: boolean;
  theme: 'light' | 'dark' | 'system';
}

// API Response types
export interface TCGPlayerResponse {
  success: boolean;
  results: TCGPlayerCard[];
}

export interface TCGPlayerCard {
  productId: number;
  name: string;
  setName: string;
  url: string;
  imageUrl: string;
  price: {
    low: number;
    mid: number;
    high: number;
    market: number;
  };
}

// Favorite storage
export interface FavoriteCard {
  cardId: string;
  addedAt: string;
  notes?: string;
}

// Search filters
export interface SearchFilters {
  rarity?: string[];
  type?: string[];
  color?: string[];
  series?: string[];
}
