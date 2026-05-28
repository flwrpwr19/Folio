import Foundation
import LocalAuthentication

let context = LAContext()
var error: NSError?
let reason = "Unlock secure album"

guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
    if let error = error {
        fputs("Biometric authentication unavailable: \(error.localizedDescription)\n", stderr)
    } else {
        fputs("Biometric authentication unavailable\n", stderr)
    }
    exit(2)
}

let semaphore = DispatchSemaphore(value: 0)
var authenticated = false
var authError: Error?

context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, error in
    authenticated = success
    authError = error
    semaphore.signal()
}

semaphore.wait()

if authenticated {
    exit(0)
}

if let authError = authError {
    let nsError = authError as NSError
    if nsError.domain == LAError.errorDomain,
       nsError.code == LAError.userCancel.rawValue || nsError.code == LAError.authenticationFailed.rawValue {
        exit(1)
    }
    fputs("Biometric authentication failed: \(authError.localizedDescription)\n", stderr)
    exit(2)
}

exit(1)
