
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  CognitoUserSession,
} from "amazon-cognito-identity-js";

const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID;
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID;

if (!userPoolId || !clientId) {
  throw new Error("Configuração do Cognito ausente no .env.local");
}

const userPool = new CognitoUserPool({
  UserPoolId: userPoolId,
  ClientId: clientId,
});

export type LoginResult =
  | {
      status: "SUCCESS";
      session: CognitoUserSession;
    }
  | {
      status: "NEW_PASSWORD_REQUIRED";
      user: CognitoUser;
      attributes: Record<string, string>;
    };

export function login(
  email: string,
  password: string
): Promise<LoginResult> {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({
      Username: email.trim(),
      Pool: userPool,
    });

    const authenticationDetails = new AuthenticationDetails({
      Username: email.trim(),
      Password: password,
    });

    user.authenticateUser(authenticationDetails, {
      onSuccess: (session) => {
        resolve({
          status: "SUCCESS",
          session,
        });
      },

      onFailure: (error) => {
        reject(error);
      },

      newPasswordRequired: (attributes) => {
        const userAttributes = {
          ...attributes,
        } as Record<string, string>;

        delete userAttributes.email_verified;
        delete userAttributes.phone_number_verified;

        resolve({
          status: "NEW_PASSWORD_REQUIRED",
          user,
          attributes: userAttributes,
        });
      },
    });
  });
}

export function completeNewPassword(
  user: CognitoUser,
  newPassword: string,
  attributes: Record<string, string>
): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(
      newPassword,
      attributes,
      {
        onSuccess: (session) => resolve(session),
        onFailure: (error) => reject(error),
      }
    );
  });
}

export function getCurrentSession(): Promise<CognitoUserSession | null> {
  return new Promise((resolve) => {
    const user = userPool.getCurrentUser();

    if (!user) {
      resolve(null);
      return;
    }

    user.getSession(
      (error: Error | null, session: CognitoUserSession | null) => {
        if (error || !session?.isValid()) {
          resolve(null);
          return;
        }

        resolve(session);
      }
    );
  });
}

export function logout(): void {
  userPool.getCurrentUser()?.signOut();
}

export function getIdToken(session: CognitoUserSession): string {
  return session.getIdToken().getJwtToken();
}
