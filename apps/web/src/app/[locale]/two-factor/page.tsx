import { AuthPageFrame, TwoFactorForm } from '@/components/auth-forms';

export default function TwoFactorPage() {
  return (
    <AuthPageFrame title="twoFactorTitle" description="twoFactorDescription">
      <TwoFactorForm />
    </AuthPageFrame>
  );
}
