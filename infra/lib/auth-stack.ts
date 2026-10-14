/**
 * Sign-in for Sift: a Cognito user pool with Cognito's hosted ("managed")
 * login pages. Deploys on its own, with nothing that bills while idle, so
 * sign-in can be built and tested from localhost before the rest of AWS.
 *
 *   browser ──(sign in)──▶ Cognito hosted login ──(code)──▶ browser
 *   browser ──(code + PKCE verifier)──▶ Cognito /oauth2/token ──▶ ID token
 *   browser ──(Authorization: Bearer <ID token>)──▶ Sift API (app/auth.py)
 *
 * Google sign-in turns on when you pass the Google OAuth client:
 *   npx cdk deploy SiftAuth -c googleClientId=<id> -c googleSecretName=sift/google-oauth
 * (the client secret lives in Secrets Manager, never in code or context).
 */
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as cognito from 'aws-cdk-lib/aws-cognito'

export interface SiftAuthStackProps extends cdk.StackProps {
  /** Where the app runs; sign-in returns here. Local dev is always included. */
  appUrls: string[]
  /** Google OAuth client ID (Google Cloud console). Omit to deploy without Google. */
  googleClientId?: string
  /** Secrets Manager secret holding the Google client secret as plain text. */
  googleSecretName?: string
}

export class SiftAuthStack extends cdk.Stack {
  readonly userPool: cognito.UserPool
  readonly client: cognito.UserPoolClient
  readonly domainUrl: string

  constructor(scope: Construct, id: string, props: SiftAuthStackProps) {
    super(scope, id, props)

    this.userPool = new cognito.UserPool(this, 'Users', {
      userPoolName: 'sift-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true }, // authenticator apps only; SMS costs money and is weaker
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    const providers = [cognito.UserPoolClientIdentityProvider.COGNITO]
    let google: cognito.UserPoolIdentityProviderGoogle | undefined
    if (props.googleClientId && props.googleSecretName) {
      google = new cognito.UserPoolIdentityProviderGoogle(this, 'Google', {
        userPool: this.userPool,
        clientId: props.googleClientId,
        clientSecretValue: cdk.SecretValue.secretsManager(props.googleSecretName),
        scopes: ['openid', 'email', 'profile'],
        attributeMapping: {
          email: cognito.ProviderAttribute.GOOGLE_EMAIL,
          emailVerified: cognito.ProviderAttribute.GOOGLE_EMAIL_VERIFIED,
          givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
          familyName: cognito.ProviderAttribute.GOOGLE_FAMILY_NAME,
        },
      })
      providers.push(cognito.UserPoolClientIdentityProvider.GOOGLE)
    }

    const urls = [...new Set(['http://localhost:5173/', ...props.appUrls.map((u) => u.replace(/\/?$/, '/'))])]
    // A browser app: no client secret, authorization code flow with PKCE.
    this.client = this.userPool.addClient('Web', {
      userPoolClientName: 'sift-web',
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      supportedIdentityProviders: providers,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: urls,
        logoutUrls: urls,
      },
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      enableTokenRevocation: true,
    })
    if (google) this.client.node.addDependency(google)

    // Hosted sign-in pages. The prefix includes the account ID so it's unique.
    const domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `sift-${this.account}` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    })
    new cognito.CfnManagedLoginBranding(this, 'Branding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.client.userPoolClientId,
      useCognitoProvidedValues: true,
    })
    this.domainUrl = domain.baseUrl()

    new cdk.CfnOutput(this, 'Region', { value: this.region })
    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId })
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.client.userPoolClientId })
    new cdk.CfnOutput(this, 'LoginDomain', { value: this.domainUrl })
    new cdk.CfnOutput(this, 'GoogleRedirectUri', {
      value: `${this.domainUrl}/oauth2/idpresponse`,
      description: 'Paste into the Google OAuth client as an authorized redirect URI',
    })
  }
}
