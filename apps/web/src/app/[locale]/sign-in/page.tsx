import { AuthPageFrame, SignInForm } from '@/components/auth-forms';
import { isGoogleAuthEnabled } from '@/server/auth';

export default function SignInPage() {
  return (
    <AuthPageFrame title="signInTitle" description="signInDescription">
      <SignInForm googleEnabled={isGoogleAuthEnabled()} />
    </AuthPageFrame>
  );
}
