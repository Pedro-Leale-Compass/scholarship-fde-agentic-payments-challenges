const isTestMode = import.meta.env.MODE === 'test'

export const env = {
  apiUrl: (
    isTestMode
      ? 'http://localhost:3000'
      : import.meta.env.VITE_API_URL ||
        'https://wok5e0vzr2.execute-api.us-east-1.amazonaws.com/prod'
  ).replace(/\/+$/, ''),
  cognitoRegion: import.meta.env.VITE_COGNITO_REGION || 'us-east-1',
  cognitoUserPoolId: isTestMode
    ? ''
    : import.meta.env.VITE_COGNITO_USER_POOL_ID || 'us-east-1_l7nZ30TH6',
  cognitoClientId: isTestMode
    ? ''
    : import.meta.env.VITE_COGNITO_CLIENT_ID || '43787t3taomlnuf8ebqki0je7d',
}
