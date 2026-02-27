'use client';

import { useState } from 'react';
import styles from './page.module.css';

export default function PricingPage() {
  const [isAnnual, setIsAnnual] = useState(false);
  const [currency, setCurrency] = useState<'USD' | 'INR'>('USD');

  const toggleBilling = () => setIsAnnual(!isAnnual);
  const toggleCurrency = () => setCurrency(prev => prev === 'USD' ? 'INR' : 'USD');

  const plans = [
    {
      id: 'starter',
      name: 'Starter',
      price: 0,
      currencySymbol: currency === 'USD' ? '$' : '₹',
      period: isAnnual ? '/yr' : '/mo',
      description: 'Perfect for personal events and small gatherings.',
      features: [
        'Unlimited Photos',
        '3 Custom Templates',
        'Standard Quality (1080p)',
        'Email & QR Sharing',
        'Basic Analytics',
      ],
      cta: 'Get Started',
      popular: false,
    },
    {
      id: 'pro',
      name: 'Professional',
      price: currency === 'USD' 
        ? (isAnnual ? 290 : 29) 
        : (isAnnual ? 24999 : 2499),
      currencySymbol: currency === 'USD' ? '$' : '₹',
      period: isAnnual ? '/yr' : '/mo',
      description: 'Best for event organizers and marketing teams.',
      features: [
        'Everything in Starter',
        'Unlimited Templates',
        'High Res (4K) Output',
        'Remove Background (AI)',
        'Custom Branding / Logo',
        'Priority Support',
      ],
      cta: 'Start Free Trial',
      popular: true,
    },
    {
      id: 'enterprise',
      name: 'Enterprise',
      price: 'Custom',
      currencySymbol: '',
      period: '',
      description: 'For large scale events and custom integrations.',
      features: [
        'Everything in Pro',
        'White Label Solution',
        'Dedicated Server Instance',
        'Custom CRM Integration',
        'SLA Guarantee',
        '24/7 Phone Support',
      ],
      cta: 'Contact Sales',
      popular: false,
    },
  ];

  const faqs = [
    {
      q: "Can I change plans later?",
      a: "Yes, you can upgrade or downgrade your plan at any time from your dashboard."
    },
    {
      q: "Is the AI background removal accurate?",
      a: "Yes! We use state-of-the-art AI models to ensure crisp cutouts even with complex backgrounds."
    },
    {
      q: "Do you offer refunds?",
      a: "We offer a 14-day money-back guarantee if you're not satisfied with the professional features."
    }
  ];

  return (
    <div className={styles.main}>
      {/* Header */}
      <header className={styles.header}>
        <h1 className={styles.title}>Simple, Transparent Pricing</h1>
        <p className={styles.subtitle}>
          Choose the perfect plan for your event needs. No hidden fees.
        </p>
      </header>

      {/* Controls Container */}
      <div className={styles.controlsContainer}>
        {/* Currency Toggle */}
        <div className={styles.toggleContainer} role="button" onClick={toggleCurrency}>
          <span className={`${styles.toggleLabel} ${currency === 'USD' ? styles.active : ''}`}>USD</span>
          <div className={`${styles.toggleSwitch} ${currency === 'INR' ? styles.checked : ''}`}>
            <div className={styles.toggleHandle} />
          </div>
          <span className={`${styles.toggleLabel} ${currency === 'INR' ? styles.active : ''}`}>INR</span>
        </div>

        {/* Billing Design Toggle */}
        <div className={styles.toggleContainer} role="button" onClick={toggleBilling}>
          <span className={`${styles.toggleLabel} ${!isAnnual ? styles.active : ''}`}>Monthly</span>
          <div className={`${styles.toggleSwitch} ${isAnnual ? styles.checked : ''}`}>
            <div className={styles.toggleHandle} />
          </div>
          <span className={`${styles.toggleLabel} ${isAnnual ? styles.active : ''}`}>
            Yearly <span style={{color: 'var(--color-success)', fontSize: '0.8em', marginLeft: '4px'}}>(-20%)</span>
          </span>
        </div>
      </div>

      {/* Pricing Cards */}
      <div className={styles.grid}>
        {plans.map((plan) => (
          <div 
            key={plan.id} 
            className={`${styles.card} ${plan.popular ? styles.cardPopular : ''}`}
          >
            {plan.popular && <div className={styles.popularBadge}>Most Popular</div>}
            
            <h2 className={styles.planName}>{plan.name}</h2>
            <div className={styles.priceContainer}>
              <span className={styles.currency}>{plan.currencySymbol}</span>
              <span className={styles.price}>{plan.price}</span>
              <span className={styles.period}>{plan.period}</span>
            </div>
            
            <p style={{marginBottom: '1.5rem', color: '#a0a0a0', lineHeight: '1.5'}}>{plan.description}</p>
            
            <ul className={styles.featureList}>
              {plan.features.map((feature, i) => (
                <li key={i} className={styles.featureItem}>
                  <span className={styles.checkIcon}>✓</span>
                  {feature}
                </li>
              ))}
            </ul>
            
            <button className={`${styles.button} ${plan.popular ? styles.buttonPrimary : ''}`}>
              {plan.cta}
            </button>
          </div>
        ))}
      </div>

      {/* FAQ Bottom Section */}
      <div className={styles.faqSection}>
        <h2 className={styles.faqTitle}>Frequently Asked Questions</h2>
        <div className={styles.faqGrid}>
          {faqs.map((faq, i) => (
            <div key={i} className={styles.faqItem}>
              <div className={styles.faqQuestion}>{faq.q}</div>
              <div className={styles.faqAnswer}>{faq.a}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
