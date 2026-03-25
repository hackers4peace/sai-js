export type Account = {
  webId: string
  email: string
  shortName: string
  password: 'password'
  registrySet: string
  auth: string
  data: { [key: string]: string }
}
