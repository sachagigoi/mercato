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
      api_usage: {
        Row: {
          calls: number
          day: string
        }
        Insert: {
          calls?: number
          day: string
        }
        Update: {
          calls?: number
          day?: string
        }
        Relationships: []
      }
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
          market_value_eur: number | null
          market_value_fetched_at: string | null
          market_value_label: string | null
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
          tm_player_id: string | null
          to_club_logo: string | null
          to_club_name: string | null
          to_competition: string | null
          to_country_code: string | null
          to_country_name: string | null
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
          market_value_eur?: number | null
          market_value_fetched_at?: string | null
          market_value_label?: string | null
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
          tm_player_id?: string | null
          to_club_logo?: string | null
          to_club_name?: string | null
          to_competition?: string | null
          to_country_code?: string | null
          to_country_name?: string | null
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
          market_value_eur?: number | null
          market_value_fetched_at?: string | null
          market_value_label?: string | null
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
          tm_player_id?: string | null
          to_club_logo?: string | null
          to_club_name?: string | null
          to_competition?: string | null
          to_country_code?: string | null
          to_country_name?: string | null
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
      apply_player_cutout: {
        Args: { p_cutout_url: string; p_name_normalized: string }
        Returns: number
      }
      consume_api_budget: { Args: { daily_cap?: number }; Returns: boolean }
      normalize_name: { Args: { value: string }; Returns: string }
    }
    Enums: {
      transfer_type: "TRANSFER" | "RUMOUR" | "EXTENSION"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      transfer_type: ["TRANSFER", "RUMOUR", "EXTENSION"],
    },
  },
} as const

// --- Alias de confort utilisés par l'app ---

export type Transfer = Database["public"]["Tables"]["transfers"]["Row"]
export type TransferInsert = Database["public"]["Tables"]["transfers"]["Insert"]
export type MediaCache = Database["public"]["Tables"]["media_cache"]["Row"]
export type TransferType = Database["public"]["Enums"]["transfer_type"]

export const TRANSFER_TYPES = ["TRANSFER", "RUMOUR", "EXTENSION"] as const
