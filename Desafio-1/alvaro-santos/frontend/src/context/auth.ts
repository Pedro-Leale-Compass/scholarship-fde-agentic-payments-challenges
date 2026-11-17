import { createContext } from 'react'
import type { CompleteNewPasswordRequest, LoginRequest, UserProfile } from '../types/auth'
export interface AuthState {
  user: UserProfile | null
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
  login: (credentials: LoginRequest) => Promise<void>
  completeNewPassword: (request: CompleteNewPasswordRequest) => Promise<void>
  logout: () => void
  refreshUser: () => Promise<void>
}
export const AuthContext = createContext<AuthState | null>(null)
