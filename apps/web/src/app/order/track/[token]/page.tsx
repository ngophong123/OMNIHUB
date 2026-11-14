import OrderTracking from '../../order-tracking';

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <OrderTracking token={token} />;
}
