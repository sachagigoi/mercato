// Généré depuis Supabase (projet mercato).
// Régénérer après toute migration :
//   supabase gen types typescript --project-id jfqtgphbpogfvofgtnax > lib/types.ts
// Ne pas éditer à la main.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      media_cache: {
        Row: {
          af_id: number | null
          cutout_attempts: number
          cutout_status: string
          cutout_url: string | null
          fetched_at: string
          id: number
          image_url: string | null
          kind: string
          miss_count: number
          name_normalized: string
        }
        Insert: {
          af_id?: number | null
          cutout_attempts?: number
          cutout_status?: string
          cutout_url?: string | null
          fetched_at?: string
          id?: never
          image_url?: string | null
          kind: string
          miss_count?: number
          name_normalized: string
        }
        Update: {
          af_id?: number | null
          cutout_attempts?: number
          cutout_status?: string
          cutout_url?: string | null
          fetched_at?: string
          id?: never
          image_url?: string | null
          kind?: string
          miss_count?: number
          name_normalized?: string
        }
        Relationships: []
      }
      transfers: {
        Row: {
          created_at: string
          external_id: string
          fee_value_eur: number | null
          from_club_logo: string | null
          from_club_name: string | null
          id: string
          is_published: boolean
          nationality_code: string | null
          player_cutout: string | null
          player_name: string
          player_photo: string | null
          previous_probability: number | null
          probability_score: number | null
          published_at: string
          source: string | null
          source_url: string | null
          status_badge: string | null
          to_club_logo: string | null
          to_club_name: string | null
          transfer_fee: string | null
          type: Database["public"]["Enums"]["transfer_type"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          external_id: string
          fee_value_eur?: number | null
          from_club_logo?: string | null
          from_club_name?: string | null
          id?: string
          is_published?: boolean
          nationality_code?: string | null
          player_cutout?: string | null
          player_name: string
          player_photo?: string | null
          previous_probability?: number | null
          probability_score?: number | null
          published_at?: string
          source?: string | null
          source_url?: string | null
          status_badge?: string | null
          to_club_logo?: string | null
          to_club_name?: string | null
          transfer_fee?: string | null
          type: Database["public"]["Enums"]["transfer_type"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          external_id?: string
          fee_value_eur?: number | null
          from_club_logo?: string | null
          from_club_name?: string | null
          id?: string
          is_published?: boolean
          nationality_code?: string | null
          player_cutout?: string | null
          player_name?: string
          player_photo?: string | null
          previous_probability?: number | null
          probability_score?: number | null
          published_at?: string
          source?: string | null
          source_url?: string | null
          status_badge?: string | null
          to_club_logo?: string | null
          to_club_name?: string | null
          transfer_fee?: string | null
          type?: Database["public"]["Enums"]["transfer_type"]
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      transfer_type: "TRANSFER" | "RUMOUR" | "EXTENSION"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

// --- Alias de confort utilisés par l'app ---

export type Transfer = Database["public"]["Tables"]["transfers"]["Row"]
export type TransferInsert = Database["public"]["Tables"]["transfers"]["Insert"]
export type MediaCache = Database["public"]["Tables"]["media_cache"]["Row"]
export type TransferType = Database["public"]["Enums"]["transfer_type"]

export const TRANSFER_TYPES = ["TRANSFER", "RUMOUR", "EXTENSION"] as const
