import { AuthPageFrame, SignUpForm } from '@/components/auth-forms';
import { isGoogleAuthEnabled } from '@/server/auth';

export default function SignUpPage() {
  return (
    <AuthPageFrame title="signUpTitle" description="signUpDescription">
      <SignUpForm googleEnabled={isGoogleAuthEnabled()} />
    </AuthPageFrame>
  );
}
