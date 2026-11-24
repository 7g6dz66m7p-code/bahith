-- SYNTHETIC phpMyAdmin-style MySQL dump for tests only. The schema and every row are
-- invented (reserved test domains, fake names); it does NOT describe the real legacy
-- database, whose structure must be read from its own dump.
SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
SET time_zone = "+00:00";
/*!40101 SET NAMES utf8mb4 */;

CREATE TABLE `members` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `email` varchar(191) DEFAULT NULL,
  `mobile` varchar(32) DEFAULT NULL,
  `full_name` varchar(191) NOT NULL,
  `created_on` datetime NOT NULL,
  `updated_on` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `members` (`id`, `email`, `mobile`, `full_name`, `created_on`, `updated_on`) VALUES
(1, 'one@example.test', '0501234567', 'باحث تجريبي', '2024-01-01 00:00:00', '2024-06-01 00:00:00'),
(2, 'two@example.test', NULL, 'Test Researcher', '2024-02-01 00:00:00', '2024-06-01 00:00:00'),
(3, NULL, '+966511111111', 'بلا بريد', '2024-03-01 00:00:00', '2024-06-01 00:00:00');

CREATE TABLE `plans_subs` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `member_id` int(11) NOT NULL,
  `plan` varchar(32) NOT NULL,
  `state` tinyint(4) NOT NULL,
  `starts_at` datetime DEFAULT NULL,
  `ends_at` datetime DEFAULT NULL,
  `payment_id` int(11) DEFAULT NULL,
  `updated_on` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `member_id` (`member_id`),
  CONSTRAINT `plans_subs_member_fk` FOREIGN KEY (`member_id`) REFERENCES `members` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `plans_subs` VALUES
(1, 1, 'premium', 1, '2024-05-01 00:00:00', '2024-06-01 00:00:00', 10, '2024-06-01 00:00:00'),
(2, 2, 'basic', 0, NULL, NULL, NULL, '2024-06-01 00:00:00');

-- MyISAM: no foreign keys are enforced or declared (common on shared hosting).
CREATE TABLE `transactions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `member_id` int(11) DEFAULT NULL,
  `amount` decimal(14,3) NOT NULL,
  `currency` char(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4;

INSERT INTO `transactions` VALUES (10, 1, 49.000, 'SAR'), (11, 99, 5.000, 'SAR');
