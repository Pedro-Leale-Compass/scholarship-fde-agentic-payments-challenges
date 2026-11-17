'use client'

import { Amplify } from 'aws-amplify'
import {
  fetchAuthSession,
  fetchUserAttributes,
  getCurrentUser,
  signOut,
} from 'aws-amplify/auth'
import { parseFrontendConfig, type FrontendConfig } from './config'

export const AUTH_MESSAGE_KEY = 'auth_message'

let configPromise: Promise<FrontendConfig> | undefined

async function loadConfig(): Promise<FrontendConfig> {
  return parseFrontendConfig({
    userPoolId: process.env.NEXT_PUBLIC_USER_POOL_ID,
    userPoolClientId: process.env.NEXT_PUBLIC_USER_POOL_CLIENT_ID,
    chatApiUrl: process.env.NEXT_PUBLIC_CHAT_API_URL,
  })
}

export function configureCognito(): Promise<FrontendConfig> {
  if (!configPromise) {
    configPromise = loadConfig().then((config) => {
      Amplify.configure({
        Auth: {
          Cognito: {
            userPoolId: config.userPoolId,
            userPoolClientId: config.userPoolClientId,
          },
        },
      })
      return config
    })
  }
  return configPromise
}

export async function getCognitoIdToken(): Promise<string | undefined> {
  await configureCognito()
  const session = await fetchAuthSession()
  return session.tokens?.idToken?.toString()
}

export function isUnauthenticated(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'UserUnAuthenticatedException'
  )
}

export async function getCognitoUser() {
  await configureCognito()
  const user = await getCurrentUser()
  const attributes = await fetchUserAttributes()
  return {
    username: user.username,
    displayName: attributes.name ?? attributes.email ?? user.username,
  }
}

export async function signOutCognito(): Promise<void> {
  await configureCognito()
  await signOut()
}
