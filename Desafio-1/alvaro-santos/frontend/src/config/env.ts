const isTestMode = import.meta.env.MODE === 'test'

export const env = {
  apiUrl: (
    isTestMode ? 'http://localhost:3000' : import.meta.env.VITE_API_URL || 'http://localhost:3000'
  ).replace(/\/+$/, ''),
  cognitoRegion: import.meta.env.VITE_COGNITO_REGION || 'us-east-1',
  cognitoUserPoolId: isTestMode ? '' : import.meta.env.VITE_COGNITO_USER_POOL_ID || '',
  cognitoClientId: isTestMode ? '' : import.meta.env.VITE_COGNITO_CLIENT_ID || '',
}
