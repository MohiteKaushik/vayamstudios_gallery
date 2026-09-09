export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      collection_photos: {
        Row: {
          collection_id: string
          created_at: string
          photo_id: string
          user_id: string
        }
        Insert: {
          collection_id: string
          created_at?: string
          photo_id: string
          user_id: string
        }
        Update: {
          collection_id?: string
          created_at?: string
          photo_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "collection_photos_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_photos_photo_id_fkey"
            columns: ["photo_id"]
            isOneToOne: false
            referencedRelation: "photos"
            referencedColumns: ["id"]
          },
        ]
      }
      collections: {
        Row: {
          created_at: string
          id: string
          name: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          user_id?: string
        }
        Relationships: []
      }
      face_detections: {
        Row: {
          box: Json | null
          created_at: string
          descriptor: number[] | null
          id: string
          photo_id: string
          similarity: number | null
          user_id: string
        }
        Insert: {
          box?: Json | null
          created_at?: string
          descriptor?: number[] | null
          id?: string
          photo_id: string
          similarity?: number | null
          user_id: string
        }
        Update: {
          box?: Json | null
          created_at?: string
          descriptor?: number[] | null
          id?: string
          photo_id?: string
          similarity?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "face_detections_photo_id_fkey"
            columns: ["photo_id"]
            isOneToOne: false
            referencedRelation: "photos"
            referencedColumns: ["id"]
          },
        ]
      }
      face_profiles: {
        Row: {
          created_at: string
          descriptor: number[]
          id: string
          image_path: string
          user_id: string
        }
        Insert: {
          created_at?: string
          descriptor: number[]
          id?: string
          image_path: string
          user_id: string
        }
        Update: {
          created_at?: string
          descriptor?: number[]
          id?: string
          image_path?: string
          user_id?: string
        }
        Relationships: []
      }
      favorites: {
        Row: {
          created_at: string
          photo_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          photo_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          photo_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "favorites_photo_id_fkey"
            columns: ["photo_id"]
            isOneToOne: false
            referencedRelation: "photos"
            referencedColumns: ["id"]
          },
        ]
      }
      photos: {
        Row: {
          best_similarity: number | null
          created_at: string
          error: string | null
          faces_count: number
          file_name: string | null
          height: number | null
          id: string
          is_match: boolean
          session_id: string
          status: string
          storage_path: string
          user_id: string
          width: number | null
        }
        Insert: {
          best_similarity?: number | null
          created_at?: string
          error?: string | null
          faces_count?: number
          file_name?: string | null
          height?: number | null
          id?: string
          is_match?: boolean
          session_id: string
          status?: string
          storage_path: string
          user_id: string
          width?: number | null
        }
        Update: {
          best_similarity?: number | null
          created_at?: string
          error?: string | null
          faces_count?: number
          file_name?: string | null
          height?: number | null
          id?: string
          is_match?: boolean
          session_id?: string
          status?: string
          storage_path?: string
          user_id?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "photos_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "search_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          onboarded: boolean
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          onboarded?: boolean
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          onboarded?: boolean
        }
        Relationships: []
      }
      scan_results: {
        Row: {
          collection_id: string
          created_at: string
          id: string
          photo_id: string
          similarity: number
          user_id: string
        }
        Insert: {
          collection_id: string
          created_at?: string
          id?: string
          photo_id: string
          similarity: number
          user_id: string
        }
        Update: {
          collection_id?: string
          created_at?: string
          id?: string
          photo_id?: string
          similarity?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scan_results_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "shared_collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scan_results_photo_id_fkey"
            columns: ["photo_id"]
            isOneToOne: false
            referencedRelation: "shared_photos"
            referencedColumns: ["id"]
          },
        ]
      }
      search_sessions: {
        Row: {
          completed_at: string | null
          created_at: string
          faces_detected: number
          failed_photos: number
          id: string
          matches_found: number
          name: string
          processed_photos: number
          status: string
          threshold: number
          total_photos: number
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          faces_detected?: number
          failed_photos?: number
          id?: string
          matches_found?: number
          name?: string
          processed_photos?: number
          status?: string
          threshold?: number
          total_photos?: number
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          faces_detected?: number
          failed_photos?: number
          id?: string
          matches_found?: number
          name?: string
          processed_photos?: number
          status?: string
          threshold?: number
          total_photos?: number
          user_id?: string
        }
        Relationships: []
      }
      shared_collections: {
        Row: {
          cover_path: string | null
          created_at: string
          created_by: string
          description: string | null
          id: string
          name: string
        }
        Insert: {
          cover_path?: string | null
          created_at?: string
          created_by: string
          description?: string | null
          id?: string
          name: string
        }
        Update: {
          cover_path?: string | null
          created_at?: string
          created_by?: string
          description?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
      shared_faces: {
        Row: {
          box: Json | null
          collection_id: string
          created_at: string
          descriptor: number[]
          id: string
          photo_id: string
        }
        Insert: {
          box?: Json | null
          collection_id: string
          created_at?: string
          descriptor: number[]
          id?: string
          photo_id: string
        }
        Update: {
          box?: Json | null
          collection_id?: string
          created_at?: string
          descriptor?: number[]
          id?: string
          photo_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shared_faces_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "shared_collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shared_faces_photo_id_fkey"
            columns: ["photo_id"]
            isOneToOne: false
            referencedRelation: "shared_photos"
            referencedColumns: ["id"]
          },
        ]
      }
      shared_photos: {
        Row: {
          collection_id: string
          created_at: string
          faces_count: number
          file_name: string | null
          height: number | null
          id: string
          storage_path: string
          uploaded_by: string
          width: number | null
        }
        Insert: {
          collection_id: string
          created_at?: string
          faces_count?: number
          file_name?: string | null
          height?: number | null
          id?: string
          storage_path: string
          uploaded_by: string
          width?: number | null
        }
        Update: {
          collection_id?: string
          created_at?: string
          faces_count?: number
          file_name?: string | null
          height?: number | null
          id?: string
          storage_path?: string
          uploaded_by?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "shared_photos_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "shared_collections"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      scan_shared_batch: {
        Args: {
          _collection_id: string
          _photo_ids: string[]
          _threshold: number
        }
        Returns: {
          r_faces: number
          r_photo_id: string
          r_similarity: number
        }[]
      }
    }
    Enums: {
      app_role: "admin" | "user"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
      app_role: ["admin", "user"],
    },
  },
} as const
